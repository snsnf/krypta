import { describe, expect, it } from "vitest"
import { ApiClientError } from "./api"
import { appTranslator } from "./app-i18n"
import { describeApiError } from "./api-error-text"

const en = appTranslator("en")
const ar = appTranslator("ar")
const err = (code: string, message: string) => new ApiClientError(code, message)

describe("describeApiError", () => {
  it("keeps the server's own text in English for every code it knows", () => {
    for (const [code, message] of [
      ["unauthorized", "Unauthorized"],
      ["not_found", "Not found"],
      ["wrong_account", "Use the invited account"],
      ["conflict", "Conflict"],
      ["form_closed", "Form is closed"],
      ["rate_limited", "Too many requests"],
      ["payload_too_large", "File is too large"],
      ["internal_error", "Something went wrong"],
      ["bad_request", "Invalid request"],
      ["bad_request", "That code is not valid"],
      ["bad_request", "Enter a valid email address"],
      ["bad_request", "Start setup first"],
      ["bad_request", "Registration is closed"],
    ] as const) {
      expect(describeApiError(err(code, message), en, "en")).toBe(message)
    }
  })

  it("translates a known code and a known bad_request message", () => {
    expect(describeApiError(err("rate_limited", "Too many requests"), ar, "ar")).toBe(
      "طلبات كثيرة جدًا"
    )
    expect(describeApiError(err("bad_request", "That code is not valid"), ar, "ar")).toBe(
      "هذا الرمز غير صالح"
    )
  })

  it("shows an unknown message verbatim in English but never leaks it into Arabic", () => {
    const unknown = err("bad_request", "Some brand new server text")
    expect(describeApiError(unknown, en, "en")).toBe("Some brand new server text")
    expect(describeApiError(unknown, ar, "ar")).toBe("حدث خطأ ما")
    expect(describeApiError(err("weird_code", "Odd"), ar, "ar")).toBe("حدث خطأ ما")
  })

  it("treats anything that is not an API error as a generic failure", () => {
    expect(describeApiError(new TypeError("fetch failed"), en, "en")).toBe(
      "Something went wrong"
    )
    expect(describeApiError(undefined, ar, "ar")).toBe("حدث خطأ ما")
  })
})
