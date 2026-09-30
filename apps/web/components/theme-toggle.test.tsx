import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: () => undefined }) }))

import { ColorModeSwitch } from "./theme-toggle"

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
