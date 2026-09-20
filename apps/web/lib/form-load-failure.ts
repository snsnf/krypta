import { ApiClientError } from "./api"
import { FormKeyMismatchError } from "./load-public-form"

export interface FormLoadFailure {
  title: string
  description: string
  /** Whether reloading the page could plausibly change the outcome. */
  retryable: boolean
}

/**
 * The reasons a public form link fails to open, in words a respondent can act
 * on. A respondent has no account and no support channel, so each message
 * says what happened and what, if anything, they can do about it.
 */
export const INCOMPLETE_LINK: FormLoadFailure = {
  title: "This link is incomplete",
  description:
    "The part after the hash sign is the key that decrypts the form, and it did not make it into this address. Ask whoever shared the link to send the whole thing.",
  retryable: false,
}

export const INCOMPLETE_EDIT_LINK: FormLoadFailure = {
  title: "This link is incomplete",
  description:
    "An edit link carries both your edit token and the form's key after the hash sign, and this address is missing one of them. Open the link exactly as it was saved.",
  retryable: false,
}

const FORM_GONE: FormLoadFailure = {
  title: "This form no longer exists",
  description:
    "Its owner has deleted it, or the address is wrong. Nothing you submitted earlier is affected.",
  retryable: false,
}

const WRONG_KEY: FormLoadFailure = {
  title: "This key does not open this form",
  description:
    "The form loaded, but the key in the link could not decrypt it. The link was probably altered when it was copied. Ask for it to be sent again.",
  retryable: false,
}

const KEY_MISMATCH: FormLoadFailure = {
  title: "This form cannot be trusted right now",
  description:
    "The key your answers would be encrypted to is not the one this form's owner set up, so someone other than the owner might be able to read them. Nothing has been sent. Let the person who shared the link know.",
  retryable: false,
}

const UNREACHABLE: FormLoadFailure = {
  title: "This form could not be loaded",
  description:
    "Something interrupted the request. Check your connection and try again.",
  retryable: true,
}

const RATE_LIMITED: FormLoadFailure = {
  title: "Too many people opened this form at once",
  description: "Wait a minute, then reload the page.",
  retryable: true,
}

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
  title: "This form is no longer available",
  description:
    "It was deleted, or your access to it was removed. It will not appear in your dashboard any more.",
  retryable: false,
}

const KEYS_PENDING: FormLoadFailure = {
  title: "Waiting for the owner",
  description:
    "You have accepted this form, but its keys are handed over the next time the owner opens their dashboard. Nothing is wrong; come back once they have.",
  retryable: true,
}

const WORKSPACE_UNREACHABLE: FormLoadFailure = {
  title: "This form could not be loaded",
  description:
    "Something interrupted the request. Check your connection and try again.",
  retryable: true,
}

const KEYS_UNREADABLE: FormLoadFailure = {
  title: "This form could not be opened",
  description:
    "Its keys did not open with your account. Reloading usually clears this; if it keeps happening, ask the owner to share the form with you again.",
  retryable: true,
}

export function describeWorkspaceLoadFailure(error: unknown): FormLoadFailure {
  if (error instanceof ApiClientError) {
    return error.code === "not_found" ? FORM_UNAVAILABLE : WORKSPACE_UNREACHABLE
  }
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return WORKSPACE_UNREACHABLE
  }
  if (error instanceof Error && error.message === "Form access is not ready") {
    return KEYS_PENDING
  }
  return KEYS_UNREADABLE
}

export const FORMS_LIST_UNREACHABLE: FormLoadFailure = {
  title: "Your forms could not be loaded",
  description:
    "Something interrupted the request. Check your connection and try again.",
  retryable: true,
}
