import { describe, expect, it } from "vitest"
import en from "../messages/en.json"
import ar from "../messages/ar.json"
import {
  formDirection,
  formTranslator,
  normalizeFormLanguage,
} from "./form-i18n"
import { normalizeFormTheme } from "./form-theme"

describe("form language", () => {
  it("accepts supported languages and falls back to English", () => {
    expect(normalizeFormLanguage("ar")).toBe("ar")
    expect(normalizeFormLanguage("en")).toBe("en")
    expect(normalizeFormLanguage("xx")).toBe("en")
    expect(normalizeFormLanguage(5)).toBe("en")
    expect(normalizeFormLanguage(undefined)).toBe("en")
  })

  it("lays Arabic out right to left", () => {
    expect(formDirection("ar")).toBe("rtl")
    expect(formDirection("en")).toBe("ltr")
  })

  it("keeps a theme's language only when it is a supported non-default value", () => {
    expect(normalizeFormTheme({ language: "ar" }).language).toBe("ar")
    expect("language" in normalizeFormTheme({ language: "en" })).toBe(false)
    expect("language" in normalizeFormTheme({ language: "xx" })).toBe(false)
    expect("language" in normalizeFormTheme({})).toBe(false)
  })
})

describe("message catalogue", () => {
  it("has the same keys in every language", () => {
    expect(Object.keys(ar.form).sort()).toEqual(Object.keys(en.form).sort())
  })

  it("formats every message in every language without leaving a placeholder", () => {
    const values = { current: 1, total: 3, question: "Q", name: "f.pdf", value: 2, max: 5, min: 1, end: "End" }
    for (const language of ["en", "ar"] as const) {
      const t = formTranslator(language)
      for (const key of Object.keys(en.form) as (keyof typeof en.form)[]) {
        const text = t(key, values)
        expect(text).not.toContain("{")
        expect(text).not.toBe(`form.${key}`)
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it("speaks Arabic for an Arabic form", () => {
    expect(formTranslator("ar")("submit")).toBe("إرسال")
    expect(formTranslator("en")("submit")).toBe("Submit")
  })
})
