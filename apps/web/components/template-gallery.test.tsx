import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/form-templates", async () =>
  vi.importActual("../lib/form-templates")
)
vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))

import { TemplateGallery } from "./template-gallery"

describe("TemplateGallery", () => {
  const markup = renderToStaticMarkup(<TemplateGallery onPick={() => undefined} />)

  it("offers six buttons with Blank form first", () => {
    const buttons = markup.match(/<button[^>]*type="button"/g) ?? []
    expect(buttons).toHaveLength(6)
    expect(markup.indexOf("Blank form")).toBeLessThan(markup.indexOf("Event feedback"))
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
})
