import { describe, expect, test } from "vitest"
import {
  FORM_THEME_PRESETS,
  DEFAULT_FORM_THEME,
  normalizeFormTheme,
  getFormThemeStyle,
  getFormVariantAttributes,
  fontVariantLabel,
} from "./form-theme"

describe("form theme", () => {
  test("exports the Forest default and all six presets", async () => {
    const { DEFAULT_FORM_THEME, FORM_THEME_PRESETS } =
      await import("./form-theme")

    expect(DEFAULT_FORM_THEME).toEqual({
      preset: "forest",
      accentColor: "#356343",
      backgroundColor: "#e8f1e9",
      typography: {
        header: { font: "Fraunces", size: 24 },
        question: { font: "Schibsted Grotesk", size: 14 },
        text: { font: "Schibsted Grotesk", size: 14 },
      },
      allowDarkMode: false,
      layout: "classic",
    })
    expect(Object.keys(FORM_THEME_PRESETS)).toEqual([
      "forest",
      "ocean",
      "plum",
      "terracotta",
      "sunflower",
      "graphite",
    ])
  })

  test("normalizes missing and malformed fields independently", async () => {
    const { normalizeFormTheme } = await import("./form-theme")

    expect(normalizeFormTheme(undefined)).toMatchObject({ preset: "forest" })
    expect(
      normalizeFormTheme({
        preset: "ocean",
        accentColor: "#3f6489",
        backgroundColor: "invalid",
        typography: {
          header: { font: "Noto Sans Arabic", size: 30 },
          question: { font: "Roboto", size: 16 },
          text: { font: "Roboto", size: 18 },
        },
        allowDarkMode: "yes",
        headerImageUrl: "javascript:alert(1)",
      })
    ).toEqual({
      preset: "ocean",
      accentColor: "#3f6489",
      backgroundColor: "#e8f1e9",
      typography: {
        header: { font: "Noto Sans Arabic", size: 30 },
        question: { font: "Roboto", size: 16 },
        text: { font: "Roboto", size: 18 },
      },
      allowDarkMode: false,
      layout: "classic",
    })
  })

  test("converts a legacy heading font into the header typography role", async () => {
    const { DEFAULT_FORM_THEME, normalizeFormTheme } =
      await import("./form-theme")

    expect(normalizeFormTheme({ headingFont: "Roboto" })).toMatchObject({
      typography: {
        header: { font: "Roboto", size: 24 },
        question: { font: "Schibsted Grotesk", size: 14 },
        text: { font: "Schibsted Grotesk", size: 14 },
      },
    })
    expect(
      normalizeFormTheme({ headingFont: "Font);background:url(x)" })
    ).toMatchObject({ typography: DEFAULT_FORM_THEME.typography })
    expect(
      normalizeFormTheme({ headingFont: "Noto Sans Arabic" }, [
        "Fraunces",
        "Noto Sans Arabic",
      ])
    ).toMatchObject({
      typography: { header: { font: "Noto Sans Arabic", size: 24 } },
    })
    expect(
      normalizeFormTheme({ headingFont: "Unknown Brand Font" }, ["Fraunces"])
    ).toMatchObject({
      typography: { header: DEFAULT_FORM_THEME.typography.header },
    })
  })

  test("normalizes each typography role independently", async () => {
    const { normalizeFormTheme } = await import("./form-theme")

    expect(
      normalizeFormTheme({
        typography: {
          header: { font: "Roboto", size: 30 },
          question: { font: "invalid);background:url(x)", size: 16 },
          text: { font: "Noto Sans Arabic", size: 99 },
        },
      })
    ).toMatchObject({
      typography: {
        header: { font: "Roboto", size: 30 },
        question: { font: "Schibsted Grotesk", size: 14 },
        text: { font: "Noto Sans Arabic", size: 14 },
      },
    })
  })

  test("validates colors", async () => {
    const { isHexColor } = await import("./form-theme")

    expect(isHexColor("#A1b2C3")).toBe(true)
    expect(isHexColor("#fff")).toBe(false)
  })

  test("chooses the higher-contrast supported foreground", async () => {
    const { getAccentForeground, getContrastRatio } =
      await import("./form-theme")

    expect(getAccentForeground("#356343")).toBe("#fafafa")
    expect(getAccentForeground("#f7f0da")).toBe("#18181b")
    expect(getContrastRatio("#356343", "#fafafa")).toBeGreaterThanOrEqual(4.5)
  })

  test("builds a same-origin stylesheet URL only for a catalogued family", async () => {
    const { getFontCssUrl } = await import("./form-theme")
    const catalog = [
      { family: "Noto Sans Arabic", id: "noto-sans-arabic" },
      { family: "Fraunces", id: "fraunces" },
    ]

    expect(getFontCssUrl("Noto Sans Arabic", catalog)).toBe(
      "/fonts/noto-sans-arabic.css"
    )
    expect(getFontCssUrl("Unknown Brand Font", catalog)).toBeNull()
    expect(getFontCssUrl("Font);background:url(x)", catalog)).toBeNull()
  })

  test("refuses a catalogue entry whose id could escape the fonts path", async () => {
    const { getFontCssUrl } = await import("./form-theme")

    expect(
      getFontCssUrl("Evil", [{ family: "Evil", id: "../../etc/passwd" }])
    ).toBeNull()
  })

  test("a dark page background in light mode flips page text light and keeps card text dark", async () => {
    const { getFormThemeStyle } = await import("./form-theme")
    const navy = getFormThemeStyle(
      { preset: "custom", accentColor: "#a35442", backgroundColor: "#1b3a6b" },
      "light"
    )
    expect(navy["--foreground"]).toBe("#fafafa")
    expect(navy["--card-foreground"]).toBe("oklch(0.145 0 0)")
    expect(navy["--muted-foreground"]).toContain("#fafafa 55%")
    expect(navy["--card-muted-foreground"]).toContain("oklch(0.52 0 0) 55%")

    const pale = getFormThemeStyle(
      { preset: "custom", accentColor: "#a35442", backgroundColor: "#f6eae6" },
      "light"
    )
    expect(pale["--foreground"]).toBe("oklch(0.145 0 0)")
    expect(pale["--muted-foreground"]).toBe(pale["--card-muted-foreground"])
  })

  test("scopes coherent role typography and dark tokens only when enabled", async () => {
    const { getFormThemeStyle } = await import("./form-theme")

    const oceanDark = getFormThemeStyle(
      { preset: "ocean", ...FORM_THEME_PRESETS.ocean, allowDarkMode: true },
      "dark"
    )
    // Every dark surface is derived from the chosen page background, so
    // Ocean's dark form carries its hue rather than a palette shared with
    // Forest, and a custom page color still shows in dark mode.
    expect(oceanDark["--form-page-background"]).toBe(
      "oklch(from #e8f0f7 0.18 clamp(0.015, c, 0.06) h)"
    )
    expect(oceanDark["--card"]).toBe(
      "oklch(from #e8f0f7 0.23 clamp(0.015, c, 0.045) h)"
    )
    expect(oceanDark["--foreground"]).toBe(
      "oklch(from #e8f0f7 0.97 min(c, 0.008) h)"
    )
    expect(
      getFormThemeStyle(
        {
          preset: "custom",
          accentColor: "#a35442",
          backgroundColor: "#157e93",
          allowDarkMode: true,
        },
        "dark"
      )["--form-page-background"]
    ).toBe("oklch(from #157e93 0.18 clamp(0.015, c, 0.06) h)")
    expect(oceanDark["--secondary"]).toBe(oceanDark["--muted"])
    expect(oceanDark["--secondary-foreground"]).toBe(oceanDark["--foreground"])
    // The accent is lifted to a legible lightness and takes dark text.
    expect(oceanDark["--primary"]).toBe("oklch(from #3f6489 max(l, 0.74) c h)")
    expect(oceanDark["--primary-foreground"]).toBe("#18181b")
    expect(oceanDark.colorScheme).toBe("dark")
    expect(
      getFormThemeStyle(
        { preset: "ocean", ...FORM_THEME_PRESETS.ocean, allowDarkMode: false },
        "dark"
      )["--form-page-background"]
    ).toBe("#e8f0f7")
    expect(
      getFormThemeStyle({
        typography: {
          header: { font: "Roboto", size: 30 },
          question: { font: "Noto Sans Arabic", size: 16 },
          text: { font: "Fraunces", size: 18 },
        },
      })
    ).toMatchObject({
      "--form-header-font": "'Roboto', var(--font-heading)",
      "--form-header-size": "30px",
      "--form-question-font": "'Noto Sans Arabic', var(--font-heading)",
      "--form-question-size": "16px",
      "--form-text-font": "'Fraunces', var(--font-heading)",
      "--form-text-size": "18px",
    })
    expect(getFormThemeStyle(undefined)).toMatchObject({
      "--form-page-background": "#e8f1e9",
      "--card": "oklch(1 0 0)",
      colorScheme: "light",
    })
  })

  test("normalizes layout, defaulting anything but focus to classic", async () => {
    const { normalizeFormTheme } = await import("./form-theme")

    expect(normalizeFormTheme(undefined)).toMatchObject({ layout: "classic" })
    expect(normalizeFormTheme({ layout: "focus" })).toMatchObject({
      layout: "focus",
    })
    expect(normalizeFormTheme({ layout: "carousel" })).toMatchObject({
      layout: "classic",
    })
    expect(normalizeFormTheme({ layout: 123 })).toMatchObject({
      layout: "classic",
    })
  })
})

describe("font variants", () => {
  const withHeader = (header: Record<string, unknown>) => ({
    ...DEFAULT_FORM_THEME,
    typography: { ...DEFAULT_FORM_THEME.typography, header },
  })

  test("keeps a catalogue-shaped variant and drops anything else", () => {
    for (const variant of ["regular", "italic", "700", "700italic"]) {
      expect(
        normalizeFormTheme(withHeader({ font: "Fraunces", size: 24, variant }))
          .typography.header.variant
      ).toBe(variant)
    }
    for (const variant of ["bold", "750", "0", "700 italic", 700]) {
      expect(
        normalizeFormTheme(withHeader({ font: "Fraunces", size: 24, variant }))
          .typography.header.variant
      ).toBeUndefined()
    }
  })

  test("sets weight and style only for a role with a chosen variant", () => {
    const theme = withHeader({
      font: "Fraunces",
      size: 24,
      variant: "600italic",
    })
    const style = getFormThemeStyle(theme) as unknown as Record<string, string>
    expect(style["--form-header-weight"]).toBe("600")
    expect(style["--form-header-style"]).toBe("italic")
    expect(style["--form-text-weight"]).toBeUndefined()
    expect(getFormVariantAttributes(theme)).toEqual({
      "data-header-variant": "true",
    })
    expect(getFormVariantAttributes(DEFAULT_FORM_THEME)).toEqual({})
  })

  test("names variants the way a person reads them", () => {
    expect(fontVariantLabel("regular")).toBe("Regular")
    expect(fontVariantLabel("italic")).toBe("Italic")
    expect(fontVariantLabel("700")).toBe("Bold")
    expect(fontVariantLabel("300italic")).toBe("Light Italic")
  })
})
