import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/form-theme", async () => vi.importActual("../lib/form-theme"))
vi.mock("@/lib/form-i18n", async () => vi.importActual("../lib/form-i18n"))
vi.mock("@/lib/font-catalog-client", () => ({ loadFontCatalog: async () => [] }))
vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))

import { FormThemeSurface } from "./form-theme-surface"
import { DEFAULT_FORM_THEME } from "../lib/form-theme"
import { useFormLanguage } from "../lib/form-i18n"

function Probe() {
  return <span data-probe>{useFormLanguage()}</span>
}

describe("FormThemeSurface language", () => {
  it("lays an Arabic form out right to left and tells its children", () => {
    const markup = renderToStaticMarkup(
      <FormThemeSurface theme={{ ...DEFAULT_FORM_THEME, language: "ar" }}>
        <Probe />
      </FormThemeSurface>
    )
    expect(markup).toContain('dir="rtl"')
    expect(markup).toContain('lang="ar"')
    expect(markup).toContain("<span data-probe=\"true\">ar</span>")
  })

  it("keeps an English form left to right", () => {
    const markup = renderToStaticMarkup(
      <FormThemeSurface theme={DEFAULT_FORM_THEME}>
        <Probe />
      </FormThemeSurface>
    )
    expect(markup).toContain('dir="ltr"')
    expect(markup).toContain('lang="en"')
    expect(markup).toContain("<span data-probe=\"true\">en</span>")
  })
})
