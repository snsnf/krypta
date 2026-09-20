import { describe, expect, test } from "vitest"
import { ApiClientError } from "./api"
import { FormKeyMismatchError } from "./load-public-form"
import {
  describeFormLoadFailure,
  describeWorkspaceLoadFailure,
} from "./form-load-failure"

describe("describeFormLoadFailure", () => {
  test("a missing form is reported as gone, not as a transient failure", () => {
    const failure = describeFormLoadFailure(
      new ApiClientError("not_found", "Not found")
    )
    expect(failure.title).toBe("This form no longer exists")
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
    expect(failure.title).toBe("Too many people opened this form at once")
    expect(failure.description).toBe("Wait a minute, then reload the page.")
    expect(failure.retryable).toBe(true)
  })

  test("a swapped public key is reported as untrustworthy, never as a bad link", () => {
    const failure = describeFormLoadFailure(new FormKeyMismatchError())
    expect(failure.title).toBe("This form cannot be trusted right now")
    expect(failure.retryable).toBe(false)
  })

  test("a failure after the form arrived is blamed on the key", () => {
    const failure = describeFormLoadFailure(new Error("incorrect key"))
    expect(failure.title).toBe("This key does not open this form")
    expect(failure.retryable).toBe(false)
  })
})

describe("describeWorkspaceLoadFailure", () => {
  test("a 404 is deletion or revocation, and not worth retrying", () => {
    const failure = describeWorkspaceLoadFailure(
      new ApiClientError("not_found", "Not found")
    )
    expect(failure.title).toBe("This form is no longer available")
    expect(failure.retryable).toBe(false)
  })

  test("a membership still awaiting keys is a wait, not a fault", () => {
    const failure = describeWorkspaceLoadFailure(
      new Error("Form access is not ready")
    )
    expect(failure.title).toBe("Waiting for the owner")
    expect(failure.retryable).toBe(true)
  })

  test("anything else that failed after the form arrived blames the keys", () => {
    expect(describeWorkspaceLoadFailure(new Error("bad mac")).title).toBe(
      "This form could not be opened"
    )
  })
})
