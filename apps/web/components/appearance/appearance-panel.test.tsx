import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/form-language", async () =>
  vi.importActual("../../lib/form-language")
)
vi.mock("@/lib/app-i18n", async () => vi.importActual("../../lib/app-i18n"))
vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("@/lib/form-theme", async () => {
  return await vi.importActual("../../lib/form-theme")
})
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}))
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}))
vi.mock("@/components/ui/label", () => ({
  Label: (props: React.ComponentProps<"label">) => <label {...props} />,
}))
vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}))
vi.mock("@/components/ui/switch", () => ({
  Switch: (props: Record<string, unknown>) => <button {...props} />,
}))
vi.mock("@/components/appearance/color-field", () => ({
  ColorField: () => null,
}))
vi.mock("@/components/appearance/font-variant-select", () => ({
  FontVariantSelect: ({ ariaLabel }: { ariaLabel: string }) => (
    <select aria-label={ariaLabel} />
  ),
}))
vi.mock("@/components/appearance/font-picker", () => ({
  FontPicker: () => null,
}))

import { AppearancePanel } from "./appearance-panel"
import { DEFAULT_FORM_THEME } from "../../lib/form-theme"

describe("AppearancePanel layout section", () => {
  it("marks Classic pressed by default and Focus pressed when selected", () => {
    const classicMarkup = renderToStaticMarkup(
      <AppearancePanel value={DEFAULT_FORM_THEME} onChange={() => undefined} />
    )
    expect(classicMarkup).toContain("Classic")
    expect(classicMarkup).toContain("Focus")
    expect(classicMarkup).toMatch(
      /aria-label="Classic layout" aria-pressed="true"/
    )

    const focusMarkup = renderToStaticMarkup(
      <AppearancePanel
        value={{ ...DEFAULT_FORM_THEME, layout: "focus" }}
        onChange={() => undefined}
      />
    )
    expect(focusMarkup).toMatch(/aria-label="Focus layout" aria-pressed="true"/)
  })
})
