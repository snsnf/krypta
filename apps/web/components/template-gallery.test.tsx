import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/form-templates", async () =>
  vi.importActual("../lib/form-templates")
)
vi.mock("@/lib/app-i18n", async () => vi.importActual("../lib/app-i18n"))
vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))

import { AppLanguageContext } from "@/lib/app-i18n"
import { TemplateGallery } from "./template-gallery"

describe("TemplateGallery", () => {
  const markup = renderToStaticMarkup(
    <TemplateGallery onPick={() => undefined} />
  )

  it("offers six buttons with Blank form first", () => {
    const buttons = markup.match(/<button[^>]*type="button"/g) ?? []
    expect(buttons).toHaveLength(6)
    expect(markup.indexOf("Blank form")).toBeLessThan(
      markup.indexOf("Event feedback")
    )
  })

  it("shows each template's name, description and question count", () => {
    expect(markup).toContain("Anonymous report")
    expect(markup).toContain("Report a concern without giving your name.")
    expect(markup).toContain("6 questions")
    expect(markup).toContain("4 questions")
  })

  it("lays the cards out in one, two, then three columns", () => {
    expect(markup).toContain("sm:grid-cols-2")
    expect(markup).toContain("lg:grid-cols-3")
  })

  it("stretches every card to its column, not to its text", () => {
    // A <button> is fit-content by default, so short cards came out narrower
    // than their neighbours.
    const buttons = markup.match(/<button[^>]*>/g) ?? []
    for (const button of buttons) expect(button).toMatch(/\bw-full\b/)
  })
})

describe("TemplateGallery in Arabic", () => {
  const markup = renderToStaticMarkup(
    <AppLanguageContext.Provider value="ar">
      <TemplateGallery onPick={() => undefined} />
    </AppLanguageContext.Provider>
  )

  it("translates the cards and the counts, with Western digits", () => {
    expect(markup).toContain("نموذج فارغ")
    expect(markup).toContain("بلاغ مجهول")
    expect(markup).toContain("6 أسئلة")
    expect(markup).toContain("4 أسئلة")
    expect(markup).not.toMatch(/[\u0660-\u0669]/)
  })

  it("aligns the cards to the reading edge", () => {
    expect(markup).toContain("text-start")
    expect(markup).not.toContain("text-left")
  })
})
