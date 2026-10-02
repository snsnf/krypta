import { ApiClientError } from "./api"
import { translateKey, type AppTranslator } from "./app-i18n"
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
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return UNREACHABLE
  }
  return WRONG_KEY
}

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
