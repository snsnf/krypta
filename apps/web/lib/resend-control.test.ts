import { describe, expect, test } from "vitest"
import { resendControlState } from "./resend-control"
import { appTranslator } from "./app-i18n"

describe("verification resend control", () => {
  test("shows the visible remaining cooldown and disables resend", () => {
    expect(resendControlState(42, false)).toEqual({
      disabled: true,
      label: "Send another code in 42s",
    })
  })

  test("stays disabled while a resend request is in flight", () => {
    expect(resendControlState(0, true)).toEqual({
      disabled: true,
      label: "Sending another code...",
    })
  })

  test("enables resend only after cooldown and request completion", () => {
    expect(resendControlState(0, false)).toEqual({
      disabled: false,
      label: "Send another code",
    })
  })
})

describe("verification resend control in Arabic", () => {
  const t = appTranslator("ar")
  test("words each state in the app's language", () => {
    expect(resendControlState(42, false, t).label).toBe("إرسال رمز آخر خلال 42 ث")
    expect(resendControlState(0, true, t).label).toBe("جارٍ إرسال رمز آخر...")
    expect(resendControlState(0, false, t).label).toBe("إرسال رمز آخر")
  })
})
