import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("@/lib/app-i18n", async () => vi.importActual("../lib/app-i18n"))
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: () => undefined }) }))

import { ColorModeSwitch, siteThemeLabels } from "./theme-toggle"
import { appTranslator } from "../lib/app-i18n"

describe("ColorModeSwitch", () => {
  it("stays left to right inside a right-to-left form, so the pill sits under its icon", () => {
    const markup = renderToStaticMarkup(
      <ColorModeSwitch
        value="light"
        label="Mode"
        optionLabels={{ light: "L", system: "S", dark: "D" }}
        onChange={() => undefined}
      />
    )
    expect(markup).toMatch(/role="radiogroup"[^>]*dir="ltr"|dir="ltr"[^>]*role="radiogroup"/)
  })
})

describe("siteThemeLabels", () => {
  it("words the site theme control in the app's language", () => {
    const en = siteThemeLabels(appTranslator("en"))
    expect(en.label).toBe("Theme")
    expect(en.optionLabels).toEqual({
      light: "Light theme",
      system: "System theme",
      dark: "Dark theme",
    })
    const ar = siteThemeLabels(appTranslator("ar"))
    expect(ar.label).toBe("المظهر")
    expect(ar.optionLabels.light).toBe("مظهر فاتح")
  })
})
