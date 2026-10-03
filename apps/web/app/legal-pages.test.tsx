import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/link", () => ({ default: "a" }))
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND")
  },
}))
vi.mock("@/components/prose-page", async () =>
  vi.importActual("../components/prose-page")
)
vi.mock("@/components/prose-document", async () =>
  vi.importActual("../components/prose-document")
)
vi.mock("@/components/language-switcher", () => ({ LanguageMenu: () => null }))
vi.mock("@/lib/legal", async () => vi.importActual("../lib/legal"))
vi.mock("@/lib/app-translator", async () =>
  vi.importActual("../lib/app-translator")
)
vi.mock("@/lib/app-locale-server", () => ({
  getAppLanguage: async () => "en",
}))
vi.mock("@/lib/legal-content/privacy", async () =>
  vi.importActual("../lib/legal-content/privacy")
)
vi.mock("@/lib/legal-content/terms", async () =>
  vi.importActual("../lib/legal-content/terms")
)

import PrivacyPage from "./privacy/page"
import TermsPage from "./terms/page"

/*
 * These two pages are the only ones that make promises in an operator's name,
 * so the gate in front of them is the thing worth testing: an instance that
 * has not said who it is must serve nothing rather than a policy with a hole
 * where the company goes.
 *
 * Rendering is markup-only, which is the limit of this vitest setup. It is
 * enough here because the pages are text: there is no state to drive.
 */
const KEYS = ["LEGAL_ENTITY", "LEGAL_CONTACT_EMAIL"] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function configure() {
  process.env.LEGAL_ENTITY = "Example Lda"
  process.env.LEGAL_CONTACT_EMAIL = "privacy@example.com"
}

describe.each([
  ["privacy", PrivacyPage],
  ["terms", TermsPage],
])("the %s page", (_name, Page) => {
  test("is not served by an instance that has named no operator", async () => {
    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND")
  })

  test("names the operator and how to reach them", async () => {
    configure()
    const html = renderToStaticMarkup(await Page())
    expect(html).toContain("Example Lda")
    expect(html).toContain("privacy@example.com")
  })
})

describe("the privacy page", () => {
  test("states the claim the software actually makes", async () => {
    configure()
    const html = renderToStaticMarkup(await PrivacyPage())
    expect(html).toContain("encrypted in your browser")
    // The password is the one thing a reader most needs to know is absent, and
    // it is absent in fact rather than by policy.
    expect(html).toContain("one-way verifier")
  })

  test("sends a respondent to the form owner rather than to the operator", async () => {
    // The operator cannot find or read an answer, so promising to act on a
    // request about one would be a promise that cannot be kept.
    configure()
    expect(renderToStaticMarkup(await PrivacyPage())).toContain(
      "has to go to them rather than"
    )
  })
})

describe("the terms page", () => {
  test("carries the warning that nothing can recover a lost vault", async () => {
    configure()
    expect(renderToStaticMarkup(await TermsPage())).toContain(
      "We cannot recover your data"
    )
  })

  test("names no governing law, which is the operator's to add", async () => {
    // Deliberately absent rather than configurable: a jurisdiction clause is
    // one an operator should write with advice, not one this template should
    // guess at from an environment variable.
    configure()
    expect(renderToStaticMarkup(await TermsPage())).not.toContain(
      "Governing law"
    )
  })
})
