"use client"

import {
  decryptWithKey,
  unsealBox,
  type FormRole,
  type FormSchema,
  type FormSettings,
  type FormTheme,
  type Question,
} from "@krypta/crypto"
import type { AccountSharingMaterial } from "./account-sharing-key"
import type { AnswerValue } from "./form-answers"
import { apiFetch } from "./api"
import { openMemberGrant } from "./form-grants"
import { normalizeFormSettings } from "./form-settings"
import { normalizeFormTheme } from "./form-theme"
import type { AnswerKey } from "./quiz"
import { openAnswerKey } from "./quiz-sealing"

/**
 * Everything a collaborator's view of one form is built from, opened in one
 * place.
 *
 * The sequence behind this (open the member grant, unwrap the form data key
 * and the form private key, decrypt the title, parse the schema, unseal every
 * response) used to sit inline in the dashboard page's load effect, mixed in
 * with auth re-checks and a dozen `setState` calls. That put a fifteen-field
 * wire type, the decryption order and the error containment inside a module
 * that cannot be tested here at all, since this unit suite has no DOM.
 *
 * `loadPublicForm` is the same shape for the respondent's side, and this is
 * deliberately built to match it: fetch, decrypt, normalise, hand back one
 * object. `decryptFormList` covers the dashboard list, which opens grants for
 * many forms and decrypts no schema and no responses, and `provisioning`
 * opens a grant only to re-seal it. Those are different sequences rather than
 * copies of this one, so they stay where they are.
 *
 * **This module decrypts, so it is `"use client"` and must stay that way.**
 * The hybrid KEM's decapsulation is not constant time, which is tolerable only
 * because it runs in the user's own browser with the user's own key. The
 * directive is what makes that structural: calling any of this from a server
 * component is a build error rather than something a reviewer has to notice.
 * Do not move it to a route handler, a server action or a worker.
 */
interface WorkspaceResponse {
  id: string
  answers: Record<string, AnswerValue>
}

interface FormWorkspace {
  role: FormRole
  version: number
  formDataKey: string
  formPrivateKey: string
  title: string
  questions: Question[]
  theme: FormTheme
  settings: FormSettings
  allowResponseEditing: boolean
  acceptingResponses: boolean
  closesAt: string | null
  maxResponses: number | null
  notifyOnResponse: boolean
  hasHeaderImage: boolean
  responses: WorkspaceResponse[]
  /**
   * How many responses did not decrypt and are therefore not in `responses`.
   *
   * Nearly always 0. It exists because the alternative shapes are both worse:
   * letting one bad response throw loses the entire workspace, which is what
   * this code used to do, and dropping them silently would hide a response
   * the owner has been sent. The dashboard list already degrades a single
   * unreadable form rather than failing the whole list; this is the same
   * choice one level down.
   */
  unreadableResponses: number
  /** Null when the form is not a quiz, or its key could not be opened. */
  answerKey: AnswerKey | null
}

interface FormWire {
  title_ciphertext: string
  schema_ciphertext: string
  form_public_key: string
  role: FormRole
  membership_state: "active" | "awaiting_keys"
  key_scheme: "master_wrap_v1" | "account_sealed_box_v1" | null
  encrypted_form_data_key: string | null
  encrypted_form_private_key: string | null
  allow_response_editing: boolean
  accepting_responses: boolean
  closes_at: string | null
  max_responses: number | null
  notify_on_response: boolean
  version: number
  header_image?: boolean
  answer_key_ciphertext?: string | null
}

/**
 * Fetches and opens one form for a member who holds the account key.
 *
 * Throws `"Form access is not ready"` for a membership whose keys have not been
 * provisioned yet, and for a payload that does not describe a usable
 * membership. `describeWorkspaceLoadFailure` matches on that exact string to
 * tell "waiting for the owner" apart from "keys unreadable", so rewording it
 * silently reclassifies the screen a collaborator sees.
 */
export async function loadFormWorkspace(
  formId: string,
  accountKey: string,
  sharing: AccountSharingMaterial
): Promise<FormWorkspace> {
  const form = await apiFetch<FormWire>(`/forms/${formId}`)

  if (
    (form.role !== "owner" &&
      form.role !== "editor" &&
      form.role !== "viewer") ||
    !Number.isSafeInteger(form.version)
  ) {
    throw new Error("Form access is not ready")
  }

  const { formDataKey, formPrivateKey } = openMemberGrant(
    form,
    accountKey,
    sharing
  )
  const title = decryptWithKey(form.title_ciphertext, formDataKey)
  const schema = JSON.parse(
    decryptWithKey(form.schema_ciphertext, formDataKey)
  ) as FormSchema

  // The API pages this listing so no single request holds a whole form's
  // responses in server memory. The workspace still needs every response
  // (search, the summary and CSV export all run over the full set in this
  // browser, since the server cannot read them), so it follows the cursor to
  // the end.
  const rawResponses: { id: string; ciphertext: string }[] = []
  let cursor: string | null = null
  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
    const page: {
      responses: { id: string; ciphertext: string }[]
      next_cursor?: string | null
    } = await apiFetch(`/forms/${formId}/responses${query}`)
    rawResponses.push(...page.responses)
    cursor = page.next_cursor ?? null
  } while (cursor !== null)

  const responses: WorkspaceResponse[] = []
  let unreadableResponses = 0
  for (const raw of rawResponses) {
    try {
      responses.push({
        id: raw.id,
        answers: JSON.parse(
          unsealBox(raw.ciphertext, formPrivateKey)
        ) as Record<string, AnswerValue>,
      })
    } catch {
      // Contained per response on purpose. One corrupt or unopenable blob used
      // to take the whole workspace down with it, so a form with a hundred
      // good responses became unreadable because of one bad one.
      unreadableResponses += 1
    }
  }

  return {
    role: form.role,
    version: form.version,
    formDataKey,
    formPrivateKey,
    title,
    questions: schema.questions,
    theme: normalizeFormTheme(schema.theme),
    settings: normalizeFormSettings(schema.settings),
    allowResponseEditing: form.allow_response_editing,
    acceptingResponses: form.accepting_responses,
    closesAt: form.closes_at,
    maxResponses: form.max_responses,
    notifyOnResponse: form.notify_on_response,
    hasHeaderImage: form.header_image === true,
    responses,
    unreadableResponses,
    answerKey: openAnswerKey(form.answer_key_ciphertext, formPrivateKey),
  }
}
