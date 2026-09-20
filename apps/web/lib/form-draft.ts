import type { AnswerValue } from "./form-answers"

/**
 * A respondent's in-progress answers, kept on their own device so closing a
 * tab does not throw the work away.
 *
 * This is the one place in the product that writes user content to disk in the
 * clear, and it is a deliberate trade rather than an oversight. A response is
 * sealed to the form's public key before it leaves the browser, but a draft has
 * not been submitted yet: there is nothing to seal it to that the same browser
 * does not already hold, since the schema key sits in the URL fragment right
 * beside it and in the history of the same profile. Encrypting a draft under
 * that key would look like protection while providing none. So the draft is
 * stored plainly, the form says so on the page, and the respondent is given a
 * control that removes it. Do not "fix" this by encrypting with a key stored
 * next to the ciphertext.
 *
 * Two consequences follow from that and must be preserved. The draft is
 * cleared the moment a response is submitted, because a draft that outlives
 * its submission is readable content nobody expects to still be there. And it
 * expires on its own, so an abandoned answer on a shared machine does not wait
 * indefinitely for a read.
 */

/**
 * A draft is dropped once it reaches this age, whether or not that form is
 * opened again: `sweepExpiredDrafts` ages out every form's draft whenever any
 * form is opened on this profile.
 *
 * The API reclaims an upload no response has referenced one day after this
 * (`UNCLAIMED_ATTACHMENT_TTL_SECONDS` in `apps/api/src/attachments/cleanup.rs`),
 * so a restored draft never names a file that has already been removed.
 * Lengthening this means lengthening that.
 */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface StoredDraft {
  savedAt: number
  answers: Record<string, AnswerValue>
}

function draftKey(formId: string): string {
  return `krypta:draft:${formId}`
}

function submittedKey(formId: string): string {
  return `krypta:submitted:${formId}`
}

/**
 * Storage is absent while server-rendering, and throws outright in some
 * privacy modes rather than merely being empty. Every caller here treats a
 * failure as "no draft": persistence is a convenience, and a form that cannot
 * be filled in because a draft could not be read would be a far worse bug than
 * the one this module exists to fix.
 */
function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null
    return window.localStorage ?? null
  } catch {
    return null
  }
}

function isValidAnswer(value: unknown): value is AnswerValue {
  if (typeof value === "string") return true
  if (Array.isArray(value)) return value.every((v) => typeof v === "string")
  if (typeof value !== "object" || value === null) return false
  const file = value as Record<string, unknown>
  return (
    typeof file.attachmentId === "string" &&
    typeof file.filename === "string" &&
    typeof file.mimeType === "string" &&
    typeof file.size === "number"
  )
}

/**
 * Removes every draft on this profile that has outlived `DRAFT_MAX_AGE_MS`.
 *
 * `loadDraft` only ever reads the form being opened, so on its own the expiry
 * reached nothing else: a respondent who abandoned one form on a shared
 * machine and never opened that link again left their answers there in the
 * clear for good. Running this whenever any form is opened makes the expiry a
 * property of the profile rather than of one link. An entry that is not a
 * readable draft is removed too, since this module owns the prefix and
 * nothing it wrote looks like that.
 */
export function sweepExpiredDrafts(): void {
  const store = storage()
  if (!store) return
  try {
    const prefix = draftKey("")
    const expired: string[] = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (key === null || !key.startsWith(prefix)) continue
      let savedAt: unknown
      try {
        savedAt = (JSON.parse(store.getItem(key) ?? "") as Partial<StoredDraft>)
          ?.savedAt
      } catch {
        savedAt = undefined
      }
      if (
        typeof savedAt !== "number" ||
        Date.now() - savedAt > DRAFT_MAX_AGE_MS
      ) {
        expired.push(key)
      }
    }
    // Collected first and removed after: removing while indexing by position
    // would skip the entry that slides into the removed one's place.
    for (const key of expired) store.removeItem(key)
  } catch {
    // Same rule as every other access here: storage that throws means no
    // sweep, never a form that cannot load.
  }
}

/**
 * Reads the saved answers for a form, or null when there are none to restore.
 *
 * Everything here is untrusted input: it is whatever is sitting under that key,
 * which another version of this app wrote, or a user edited by hand. Values
 * that are not a recognised answer shape are dropped individually rather than
 * failing the whole read, so one bad entry cannot cost a respondent the rest of
 * their work.
 */
export function loadDraft(formId: string): Record<string, AnswerValue> | null {
  const store = storage()
  if (!store) return null

  let raw: string | null
  try {
    raw = store.getItem(draftKey(formId))
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const draft = parsed as Partial<StoredDraft>
  if (typeof draft.savedAt !== "number") return null
  if (Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS) {
    clearDraft(formId)
    return null
  }
  if (
    typeof draft.answers !== "object" ||
    draft.answers === null ||
    Array.isArray(draft.answers)
  ) {
    return null
  }

  const answers: Record<string, AnswerValue> = {}
  for (const [id, value] of Object.entries(draft.answers)) {
    if (isValidAnswer(value)) answers[id] = value
  }
  return Object.keys(answers).length > 0 ? answers : null
}

/**
 * Writes the answers for a form. An empty set removes the draft instead of
 * storing one, so clearing the last field leaves nothing behind.
 *
 * Returns whether anything is now on this device. The page tells the respondent
 * their answers are saved here, which is a promise made to someone who may be
 * on a shared machine, so it has to be answered by the write actually landing
 * rather than inferred from what is on screen. The two disagree whenever
 * storage is blocked or full, during the window before a debounced write, and
 * when every answer is an empty string.
 */
export function saveDraft(
  formId: string,
  answers: Record<string, AnswerValue>
): boolean {
  const store = storage()
  if (!store) return false
  if (Object.keys(answers).length === 0) {
    clearDraft(formId)
    return false
  }
  const draft: StoredDraft = { savedAt: Date.now(), answers }
  try {
    store.setItem(draftKey(formId), JSON.stringify(draft))
    return true
  } catch {
    // A full disk or a storage-blocking privacy mode. The form keeps working
    // from memory; only resuming is lost.
    return false
  }
}

export function clearDraft(formId: string): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(draftKey(formId))
  } catch {
    // Nothing to do: the draft is unreadable to us either way.
  }
}

/**
 * The marker behind the one-response-per-person setting. It lives beside the
 * draft because both are per-form respondent state under the same key prefix,
 * and one module owning the prefix is what keeps the two from being spelled
 * out by hand in a page and drifting apart.
 *
 * This is not, and cannot be, an enforcement mechanism: submission is
 * anonymous, so the server has nothing to key a person on. Clearing site data
 * or opening another browser defeats it, by design.
 */
export function hasSubmitted(formId: string): boolean {
  const store = storage()
  if (!store) return false
  try {
    return store.getItem(submittedKey(formId)) === "1"
  } catch {
    return false
  }
}

export function markSubmitted(formId: string): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(submittedKey(formId), "1")
  } catch {
    // See saveDraft: losing this costs a duplicate response, not the response.
  }
}
