import { describe, expect, it, test } from "vitest"

describe("form settings", () => {
  test("defaults to allowing multiple responses", async () => {
    const { DEFAULT_FORM_SETTINGS } = await import("./form-settings")
    expect(DEFAULT_FORM_SETTINGS).toEqual({ allowMultipleResponses: true })
  })

  test("normalizes missing and malformed input to the default", async () => {
    const { normalizeFormSettings } = await import("./form-settings")
    expect(normalizeFormSettings(undefined)).toEqual({
      allowMultipleResponses: true,
    })
    expect(normalizeFormSettings(null)).toEqual({
      allowMultipleResponses: true,
    })
    expect(
      normalizeFormSettings({ allowMultipleResponses: "nope" })
    ).toEqual({ allowMultipleResponses: true })
  })

  test("preserves a valid explicit value", async () => {
    const { normalizeFormSettings } = await import("./form-settings")
    expect(normalizeFormSettings({ allowMultipleResponses: false })).toEqual({
      allowMultipleResponses: false,
    })
  })

  it("keeps a confirmation message when it is a string", async () => {
    const { normalizeFormSettings } = await import("./form-settings")
    expect(
      normalizeFormSettings({
        allowMultipleResponses: true,
        confirmationMessage: "See you Friday.",
      }).confirmationMessage
    ).toBe("See you Friday.")
  })

  it("drops a confirmation message that is not a string", async () => {
    const { normalizeFormSettings } = await import("./form-settings")
    expect(
      normalizeFormSettings({ allowMultipleResponses: true, confirmationMessage: 42 })
        .confirmationMessage
    ).toBeUndefined()
  })

  it("drops a blank confirmation message so the default text is used", async () => {
    const { normalizeFormSettings } = await import("./form-settings")
    expect(
      normalizeFormSettings({ allowMultipleResponses: true, confirmationMessage: "   " })
        .confirmationMessage
    ).toBeUndefined()
  })
})
