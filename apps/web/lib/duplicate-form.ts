"use client"

import { decryptBytesWithKey, encryptBytesWithKey } from "@krypta/crypto"
import type { AccountSharingMaterial } from "./account-sharing-key"
import { apiDownloadBytes, apiFetch, apiUploadBytes } from "./api"
import { createForm } from "./create-form"
import { loadFormDefinition } from "./form-workspace"

/**
 * Copies a form in this browser. The original is opened with the member's
 * own access; the copy is created with brand-new keys, so the server sees an
 * ordinary new form and nothing that links it to the original.
 *
 * "use client" because it opens a member's grant, which decapsulates: see
 * "Sealing to a public key" in the root CLAUDE.md.
 */
export async function duplicateForm(
  formId: string,
  accountKey: string,
  sharing: AccountSharingMaterial,
  /** The copy's title, in the app's language; the original's is passed in. */
  copyTitle: (title: string) => string = (title) => `Copy of ${title}`
): Promise<{ id: string; formDataKey: string; headerCopied: boolean }> {
  const original = await loadFormDefinition(formId, accountKey, sharing)
  if (original.role !== "owner" && original.role !== "editor") {
    throw new Error("Only owners and editors can duplicate a form")
  }

  const copy = await createForm({
    accountKey,
    title: copyTitle(original.title),
    questions: original.questions,
    theme: original.theme,
    settings: original.settings,
    answerKey: original.answerKey,
    allowResponseEditing: original.allowResponseEditing,
    notifyOnResponse: original.notifyOnResponse,
    maxResponses: original.maxResponses,
    // A copy starts open: a past close date would make it closed at birth.
    acceptingResponses: true,
    closesAt: null,
  })

  if (!original.hasHeaderImage) return { ...copy, headerCopied: true }

  // The copy already exists, so a failure here is reported as a missing
  // image, never as a failed duplicate.
  try {
    const sealed = await apiDownloadBytes(`/forms/${formId}/header-image`)
    const bytes = decryptBytesWithKey(sealed, original.formDataKey)
    const { attachment_id } = await apiUploadBytes<{ attachment_id: string }>(
      `/forms/${copy.id}/attachments`,
      encryptBytesWithKey(bytes, copy.formDataKey)
    )
    // Version 1: the copy was created a moment ago and nobody else can have
    // written to it.
    await apiFetch(`/forms/${copy.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        header_attachment_id: attachment_id,
        expected_version: 1,
      }),
    })
    return { ...copy, headerCopied: true }
  } catch {
    return { ...copy, headerCopied: false }
  }
}
