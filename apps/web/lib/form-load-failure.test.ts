import { describe, expect, test } from "vitest"
import { ApiClientError } from "./api"
import { FormKeyMismatchError } from "./load-public-form"
import { appTranslator } from "./app-i18n"
import {
  FORMS_LIST_UNREACHABLE,
  INCOMPLETE_EDIT_LINK,
  INCOMPLETE_LINK,
  describeFormLoadFailure,
  describeWorkspaceLoadFailure,
  failureText,
  type FormLoadFailure,
} from "./form-load-failure"

describe("describeFormLoadFailure", () => {
  test("a missing form is reported as gone, not as a transient failure", () => {
    const failure = describeFormLoadFailure(
      new ApiClientError("not_found", "Not found")
    )
    expect(failure.key).toBe("formGone")
    expect(failure.retryable).toBe(false)
  })

  test("a network failure is the one case worth retrying", () => {
    expect(
      describeFormLoadFailure(new TypeError("fetch failed")).retryable
    ).toBe(true)
    expect(
      describeFormLoadFailure(new SyntaxError("Unexpected token <")).retryable
    ).toBe(true)
    expect(
      describeFormLoadFailure(new ApiClientError("unknown", "Request failed"))
        .retryable
    ).toBe(true)
  })

  test("a rate-limited load tells the respondent to wait, not to check their connection", () => {
    const failure = describeFormLoadFailure(
      new ApiClientError("rate_limited", "Too many requests")
    )
    expect(failure.key).toBe("rateLimited")
    expect(failure.retryable).toBe(true)
  })

  test("a swapped public key is reported as untrustworthy, never as a bad link", () => {
    const failure = describeFormLoadFailure(new FormKeyMismatchError())
    expect(failure.key).toBe("keyMismatch")
    expect(failure.retryable).toBe(false)
  })

  test("a failure after the form arrived is blamed on the key", () => {
    const failure = describeFormLoadFailure(new Error("incorrect key"))
    expect(failure.key).toBe("wrongKey")
    expect(failure.retryable).toBe(false)
  })
})

describe("describeWorkspaceLoadFailure", () => {
  test("a 404 is deletion or revocation, and not worth retrying", () => {
    const failure = describeWorkspaceLoadFailure(
      new ApiClientError("not_found", "Not found")
    )
    expect(failure.key).toBe("formUnavailable")
    expect(failure.retryable).toBe(false)
  })

  test("a membership still awaiting keys is a wait, not a fault", () => {
    const failure = describeWorkspaceLoadFailure(
      new Error("Form access is not ready")
    )
    expect(failure.key).toBe("keysPending")
    expect(failure.retryable).toBe(true)
  })

  test("anything else that failed after the form arrived blames the keys", () => {
    expect(describeWorkspaceLoadFailure(new Error("bad mac")).key).toBe(
      "keysUnreadable"
    )
  })
})

describe("failureText", () => {
  const en = appTranslator("en")
  const ar = appTranslator("ar")

  test("keeps every English title exactly as it was", () => {
    const titles: [FormLoadFailure, string][] = [
      [INCOMPLETE_LINK, "This link is incomplete"],
      [INCOMPLETE_EDIT_LINK, "This link is incomplete"],
      [FORMS_LIST_UNREACHABLE, "Your forms could not be loaded"],
      [describeFormLoadFailure(new ApiClientError("not_found", "x")), "This form no longer exists"],
      [describeFormLoadFailure(new FormKeyMismatchError()), "This form cannot be trusted right now"],
      [describeFormLoadFailure(new Error("k")), "This key does not open this form"],
      [describeFormLoadFailure(new TypeError("net")), "This form could not be loaded"],
      [describeFormLoadFailure(new ApiClientError("rate_limited", "x")), "Too many people opened this form at once"],
      [describeWorkspaceLoadFailure(new ApiClientError("not_found", "x")), "This form is no longer available"],
      [describeWorkspaceLoadFailure(new Error("Form access is not ready")), "Waiting for the owner"],
      [describeWorkspaceLoadFailure(new Error("x")), "This form could not be opened"],
      [describeWorkspaceLoadFailure(new TypeError("net")), "This form could not be loaded"],
    ]
    for (const [failure, title] of titles) {
      expect(failureText(en, failure).title).toBe(title)
    }
    expect(failureText(en, INCOMPLETE_LINK).description).toContain(
      "The part after the hash sign is the key that decrypts the form"
    )
  })

  test("translates for Arabic", () => {
    expect(failureText(ar, INCOMPLETE_LINK).title).toBe("هذا الرابط ناقص")
    expect(failureText(ar, FORMS_LIST_UNREACHABLE).title).toBe("تعذّر تحميل نماذجك")
  })
})
