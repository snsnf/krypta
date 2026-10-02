import { ApiClientError } from "./api"
import { translateKey, type AppTranslator } from "./app-translator"
import { FormKeyMismatchError } from "./load-public-form"

/*
 * What went wrong loading a form, as a key into the `failure` messages plus
 * whether a retry is worth offering. The words live in messages/*.json so each
 * screen can word them in the app's language (see `failureText`); a descriptor
 * is created in an async handler, outside render, where no language is known.
 */
export type FailureKey =
  | "incompleteLink"
  | "incompleteEditLink"
  | "formGone"
  | "wrongKey"
  | "keyMismatch"
  | "unreachable"
  | "rateLimited"
  | "formUnavailable"
  | "keysPending"
  | "keysUnreadable"
  | "formsListUnreachable"

export interface FormLoadFailure {
  key: FailureKey
  retryable: boolean
}

export function failureText(
  t: AppTranslator,
  failure: FormLoadFailure
): { title: string; description: string } {
  return {
    title: translateKey(t, `failure.${failure.key}.title`),
    description: translateKey(t, `failure.${failure.key}.description`),
  }
}

/**
 * The reasons a public form link fails to open, in words a respondent can act
 * on. A respondent has no account and no support channel, so each message
 * says what happened and what, if anything, they can do about it.
 */
export const INCOMPLETE_LINK: FormLoadFailure = {
  key: "incompleteLink",
  retryable: false,
}

export const INCOMPLETE_EDIT_LINK: FormLoadFailure = {
  key: "incompleteEditLink",
  retryable: false,
}

const FORM_GONE: FormLoadFailure = { key: "formGone", retryable: false }

const WRONG_KEY: FormLoadFailure = { key: "wrongKey", retryable: false }

const KEY_MISMATCH: FormLoadFailure = { key: "keyMismatch", retryable: false }

const UNREACHABLE: FormLoadFailure = { key: "unreachable", retryable: true }

const RATE_LIMITED: FormLoadFailure = { key: "rateLimited", retryable: true }

export function describeFormLoadFailure(error: unknown): FormLoadFailure {
  if (error instanceof FormKeyMismatchError) return KEY_MISMATCH
  if (error instanceof ApiClientError) {
    if (error.code === "not_found") return FORM_GONE
    if (error.code === "rate_limited") return RATE_LIMITED
    return UNREACHABLE
  }
  // apiFetch parses JSON before it can throw an ApiClientError, so a dead
  // network or a proxy error page surfaces as a fetch TypeError or a
  // SyntaxError rather than as a coded failure. Anything else is thrown by
  // the decryption step after the form itself arrived intact.
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return UNREACHABLE
  }
  return WRONG_KEY
}

/**
 * The same sorting for a signed-in member opening a form from the dashboard,
 * where the audience and the causes differ: the API answers 404 both for a
 * deleted form and for a revoked membership, and a collaborator who accepted
 * before the owner provisioned their keys is told to wait rather than that
 * something broke.
 */
const FORM_UNAVAILABLE: FormLoadFailure = {
  key: "formUnavailable",
  retryable: false,
}

const KEYS_PENDING: FormLoadFailure = { key: "keysPending", retryable: true }

const KEYS_UNREADABLE: FormLoadFailure = {
  key: "keysUnreadable",
  retryable: true,
}

export function describeWorkspaceLoadFailure(error: unknown): FormLoadFailure {
  if (error instanceof ApiClientError) {
    return error.code === "not_found" ? FORM_UNAVAILABLE : UNREACHABLE
  }
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return UNREACHABLE
  }
  if (error instanceof Error && error.message === "Form access is not ready") {
    return KEYS_PENDING
  }
  return KEYS_UNREADABLE
}

export const FORMS_LIST_UNREACHABLE: FormLoadFailure = {
  key: "formsListUnreachable",
  retryable: true,
}
