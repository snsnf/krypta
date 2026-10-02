import { ApiClientError } from "./api"
import { translateKey, type AppTranslator } from "./app-i18n"
import type { AppLanguage } from "./app-locale"

const BY_CODE: Record<string, string> = {
  unauthorized: "errors.unauthorized",
  not_found: "errors.notFound",
  wrong_account: "errors.wrongAccount",
  conflict: "errors.conflict",
  form_closed: "errors.formClosed",
  checkout_in_progress: "errors.checkoutInProgress",
  active_subscription: "errors.activeSubscription",
  rate_limited: "errors.rateLimited",
  payload_too_large: "errors.payloadTooLarge",
  internal_error: "errors.internal",
}

// The only free-text bad_request messages the auth flows can return (the API's
// BadRequest(...) strings), so each has a translated key.
const BAD_REQUEST_MESSAGES: Record<string, string> = {
  "Invalid request": "errors.invalidRequest",
  "That code is not valid": "errors.codeInvalid",
  "Enter a valid email address": "errors.invalidEmail",
  "Start setup first": "errors.startSetupFirst",
  "Registration is closed": "errors.registrationClosed",
}

/**
 * What to show for a failed API call, in the app's language. The server's
 * message is English, so it is mapped by code (or, for bad_request, by its
 * exact text) to a translated key. English output is unchanged: those values
 * equal the server's strings, and an unmapped message still shows verbatim in
 * English. In any other language an unmapped message is never leaked.
 */
export function describeApiError(
  error: unknown,
  t: AppTranslator,
  language: AppLanguage
): string {
  if (!(error instanceof ApiClientError)) return t("common.somethingWrong")
  const key =
    error.code === "bad_request"
      ? Object.hasOwn(BAD_REQUEST_MESSAGES, error.message)
        ? BAD_REQUEST_MESSAGES[error.message]
        : undefined
      : Object.hasOwn(BY_CODE, error.code)
        ? BY_CODE[error.code]
        : undefined
  if (key !== undefined) return translateKey(t, key)
  return language === "en" ? error.message : t("common.somethingWrong")
}
