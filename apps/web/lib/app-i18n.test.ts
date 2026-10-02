import { describe, expect, it } from "vitest"
import en from "../messages/en.json"
import ar from "../messages/ar.json"
import { appTranslator, translateKey, type AppTranslator } from "./app-i18n"

type RichT = { rich: (key: string, values: Record<string, unknown>) => unknown }

function leaves(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k)
  )
}
const appKeys = (messages: Record<string, unknown>) =>
  leaves(Object.fromEntries(Object.entries(messages).filter(([k]) => k !== "form")))

describe("app message catalogue", () => {
  it("has the same keys in every language", () => {
    expect(appKeys(ar).sort()).toEqual(appKeys(en).sort())
  })

  it("formats every message in every language", () => {
    const values = { email: "a@b.c", seconds: 7 }
    for (const language of ["en", "ar"] as const) {
      const t = appTranslator(language)
      for (const key of appKeys(en)) {
        const message = key.endsWith("notTwoFactor")
          ? (t as unknown as RichT).rich(key, {
              ...values,
              strong: (chunks: unknown) => chunks,
            })
          : translateKey(t as AppTranslator, key, values)
        const text = Array.isArray(message) ? message.join("") : String(message)
        expect(text, `${language} ${key}`).not.toContain("{")
        expect(text, `${language} ${key}`).not.toBe(key)
        expect(text.length, `${language} ${key}`).toBeGreaterThan(0)
      }
    }
  })

  it("speaks Arabic and keeps English as it was", () => {
    expect(appTranslator("ar")("auth.login.title")).toBe("تسجيل الدخول")
    expect(appTranslator("en")("auth.login.title")).toBe("Log in")
    expect(appTranslator("en")("auth.resend.sendAnotherIn", { seconds: 42 })).toBe(
      "Send another code in 42s"
    )
  })

  it("keeps the respondent form messages out of the app catalogue", () => {
    expect(appKeys(en).some((key) => key.startsWith("form."))).toBe(false)
  })
})
