import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/app-locale-provider", async () =>
  vi.importActual("../../components/app-locale-provider")
)
vi.mock("@/lib/app-i18n", async () => vi.importActual("../../lib/app-i18n"))
vi.mock("@/lib/form-language", async () =>
  vi.importActual("../../lib/form-language")
)

import RespondentLayout, { metadata } from "./layout"

describe("the public form layout", () => {
  it("keeps forms out of search engines", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(metadata.title).toBe("Form")
  })

  it("shares the same neutral card for every form, image included", () => {
    // A form's title is ciphertext the server cannot read, so the card must say
    // nothing about which form it is. Declaring openGraph at all replaces the
    // root layout's, so the image has to be repeated here.
    expect(metadata.openGraph).toMatchObject({
      title: "Someone shared an encrypted form",
      images: ["/opengraph-image"],
    })
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      images: ["/opengraph-image"],
    })
  })

  it("pins English and left to right around the form", () => {
    const markup = renderToStaticMarkup(
      <RespondentLayout>
        <p>child</p>
      </RespondentLayout>
    )
    expect(markup).toContain('lang="en"')
    expect(markup).toContain('dir="ltr"')
    expect(markup).toContain("child")
  })
})
