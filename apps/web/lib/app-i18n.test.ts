import { readFileSync } from "node:fs"
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
  leaves(
    Object.fromEntries(Object.entries(messages).filter(([k]) => k !== "form"))
  )

function messageAt(messages: unknown, key: string): string {
  return key
    .split(".")
    .reduce(
      (node, part) => (node as Record<string, unknown>)[part],
      messages
    ) as string
}

// The values a message needs, read off its English text, so a new placeholder
// never needs an edit here. Every value is the number 3, which a plural
// selects on and a plain placeholder just prints.
function placeholdersOf(key: string): Record<string, number> {
  const names = [...messageAt(en, key).matchAll(/\{(\w+)[,}]/g)].map(
    (m) => m[1]
  )
  return Object.fromEntries(names.map((name) => [name, 3]))
}

describe("app message catalogue", () => {
  it("has the same keys in every language", () => {
    expect(appKeys(ar).sort()).toEqual(appKeys(en).sort())
  })

  it("formats every message in every language", () => {
    for (const language of ["en", "ar"] as const) {
      const t = appTranslator(language)
      for (const key of appKeys(en)) {
        const values = placeholdersOf(key)
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

  it("gives every Arabic plural all six categories, in Western digits", () => {
    const plurals = appKeys(en).filter((key) =>
      /plural,/.test(messageAt(en, key))
    )
    expect(plurals.length).toBeGreaterThan(0)
    for (const key of plurals) {
      const source = messageAt(ar, key)
      for (const category of ["zero", "one", "two", "few", "many", "other"]) {
        expect(source, `ar ${key} ${category}`).toContain(`${category} {`)
      }
      const names = Object.keys(placeholdersOf(key))
      for (const count of [0, 1, 2, 3, 11, 100]) {
        const text = translateKey(
          appTranslator("ar") as AppTranslator,
          key,
          Object.fromEntries(names.map((name) => [name, count]))
        )
        expect(text, `ar ${key} ${count}`).not.toMatch(/[\u0660-\u0669]/)
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it("speaks Arabic and keeps English as it was", () => {
    expect(appTranslator("ar")("auth.login.title")).toBe("تسجيل الدخول")
    expect(appTranslator("en")("auth.login.title")).toBe("Log in")
    expect(
      appTranslator("en")("auth.resend.sendAnotherIn", { seconds: 42 })
    ).toBe("Send another code in 42s")
  })

  it("keeps the respondent form messages out of the app catalogue", () => {
    expect(appKeys(en).some((key) => key.startsWith("form."))).toBe(false)
  })
})

describe("the server-safe translator module", () => {
  it("never imports React, so a Server Component can use it", () => {
    // not-found.tsx and the root layout run on the server, where a module that
    // calls createContext is a build error. The context lives in app-i18n.ts.
    const source = readFileSync(
      new URL("./app-translator.ts", import.meta.url),
      "utf8"
    )
    expect(source).not.toMatch(/from\s+["']react["']/)
    expect(source).toContain("export function appTranslator")
  })
})
