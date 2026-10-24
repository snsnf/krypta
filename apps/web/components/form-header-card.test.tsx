import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/form-i18n", async () => vi.importActual("../lib/form-i18n"))
vi.mock("@/lib/form-description", async () =>
  vi.importActual("../lib/form-description")
)
vi.mock("@/lib/text-direction", async () =>
  vi.importActual("../lib/text-direction")
)
vi.mock("@/lib/utils", async () => vi.importActual("../lib/utils"))
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div />,
}))

import { FormHeaderCard } from "./form-header-card"

describe("FormHeaderCard", () => {
  it("shows the description under the title, keeping its line breaks", () => {
    const markup = renderToStaticMarkup(
      <FormHeaderCard title="Visit survey" description={"Line one\nLine two"} />
    )
    expect(markup).toMatch(
      /<h2[^>]*>Visit survey<\/h2><p dir="auto" class="[^"]*whitespace-pre-line[^"]*">Line one\nLine two<\/p>/
    )
  })

  it("draws nothing for a form without a description", () => {
    const markup = renderToStaticMarkup(<FormHeaderCard title="Visit survey" />)
    expect(markup).not.toContain("<p")
  })

  it("offers a capped description field in the builder", () => {
    const markup = renderToStaticMarkup(
      <FormHeaderCard
        title=""
        description=""
        onTitleChange={() => undefined}
        onDescriptionChange={() => undefined}
      />
    )
    const field = markup.match(/<textarea[^>]*>/)?.[0] ?? ""
    expect(field).toContain('aria-label="Form description"')
    expect(field).toContain('placeholder="Add a description (optional)"')
    expect(field).toContain('maxLength="2000"')
    // Empty, so it follows the page's direction rather than resolving to ltr.
    expect(field).not.toContain("dir=")
  })
})
