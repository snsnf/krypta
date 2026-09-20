import type { CSSProperties } from "react"
import type { FormTheme, FormThemePreset, FormTypography } from "@krypta/crypto"

export const FORM_THEME_PRESETS = {
  forest: { accentColor: "#356343", backgroundColor: "#e8f1e9" },
  ocean: { accentColor: "#3f6489", backgroundColor: "#e8f0f7" },
  plum: { accentColor: "#74556f", backgroundColor: "#f1eaf0" },
  terracotta: { accentColor: "#a35442", backgroundColor: "#f6eae6" },
  sunflower: { accentColor: "#8a6a20", backgroundColor: "#f7f0da" },
  graphite: { accentColor: "#525960", backgroundColor: "#eceeef" },
} as const

export type FormRenderMode = "light" | "dark"

export const FORM_TYPOGRAPHY_SIZES = {
  header: [24, 30, 36],
  question: [14, 16, 18],
  text: [14, 16, 18],
} as const

export const DEFAULT_FORM_BUNDLED_FONTS = [
  "Fraunces",
  "Schibsted Grotesk",
] as const

const DEFAULT_TYPOGRAPHY = {
  header: { font: "Fraunces", size: 24 },
  question: { font: "Schibsted Grotesk", size: 14 },
  text: { font: "Schibsted Grotesk", size: 14 },
} as const

function defaultTypography(): FormTheme["typography"] {
  return {
    header: { ...DEFAULT_TYPOGRAPHY.header },
    question: { ...DEFAULT_TYPOGRAPHY.question },
    text: { ...DEFAULT_TYPOGRAPHY.text },
  }
}

export const DEFAULT_FORM_THEME: FormTheme = {
  preset: "forest",
  ...FORM_THEME_PRESETS.forest,
  typography: defaultTypography(),
  allowDarkMode: false,
  layout: "classic",
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const FONT_FAMILY = /^[\p{L}\p{N} ._-]{1,100}$/u
const PRESETS = new Set<FormThemePreset>([
  ...Object.keys(FORM_THEME_PRESETS),
  "custom",
] as FormThemePreset[])
const LIGHT_FOREGROUND = "#fafafa"
const DARK_FOREGROUND = "#18181b"

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value)
}

function channel(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const value = hex.slice(1)
  return (
    0.2126 * channel(Number.parseInt(value.slice(0, 2), 16)) +
    0.7152 * channel(Number.parseInt(value.slice(2, 4), 16)) +
    0.0722 * channel(Number.parseInt(value.slice(4, 6), 16))
  )
}

export function getContrastRatio(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b))
  const darker = Math.min(luminance(a), luminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

export function getAccentForeground(accent: string): string {
  return getContrastRatio(accent, LIGHT_FOREGROUND) >=
    getContrastRatio(accent, DARK_FOREGROUND)
    ? LIGHT_FOREGROUND
    : DARK_FOREGROUND
}

const FONT_ID = /^[a-z0-9-]{1,100}$/
const FONT_VARIANT = /^(?:regular|italic|[1-9]00(?:italic)?)$/

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
}

/** A catalogue variant as a person reads it: "700italic" is "Bold Italic". */
export function fontVariantLabel(variant: string): string {
  const { weight, italic } = parseFontVariant(variant)
  const name = WEIGHT_NAMES[weight] ?? String(weight)
  if (!italic) return name
  return weight === 400 ? "Italic" : `${name} Italic`
}

/** The weight and style a catalogue variant name stands for. */
export function parseFontVariant(variant: string): {
  weight: number
  italic: boolean
} {
  const italic = variant.endsWith("italic")
  const digits = variant.replace("italic", "")
  const weight = digits === "" || digits === "regular" ? 400 : Number(digits)
  return { weight, italic }
}

/**
 * The stylesheet for a family, served from this origin, or null when the
 * family is not in the supplied catalogue. The catalogue is the authorisation:
 * a theme names any string it likes, and only a name that resolves to a
 * generated stylesheet ever becomes a request.
 */
export function getFontCssUrl(
  family: string,
  catalog: readonly { family: string; id: string }[]
): string | null {
  if (!FONT_FAMILY.test(family)) return null
  const entry = catalog.find((candidate) => candidate.family === family)
  if (!entry || !FONT_ID.test(entry.id)) return null
  return `/fonts/${entry.id}.css`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAllowedFont(
  value: unknown,
  allowedFonts?: readonly string[]
): value is string {
  return (
    typeof value === "string" &&
    FONT_FAMILY.test(value) &&
    (allowedFonts === undefined ||
      DEFAULT_FORM_BUNDLED_FONTS.includes(
        value as (typeof DEFAULT_FORM_BUNDLED_FONTS)[number]
      ) ||
      allowedFonts.includes(value))
  )
}

type TypographyRole = keyof typeof FORM_TYPOGRAPHY_SIZES

function normalizeTypographyRole(
  value: unknown,
  role: TypographyRole,
  allowedFonts?: readonly string[]
): FormTypography {
  const fallback = DEFAULT_TYPOGRAPHY[role]
  if (!isRecord(value)) return { ...fallback }
  if (!isAllowedFont(value.font, allowedFonts)) return { ...fallback }
  const sizes = FORM_TYPOGRAPHY_SIZES[role] as readonly number[]
  const size =
    typeof value.size === "number" && sizes.includes(value.size)
      ? value.size
      : fallback.size
  const typography: FormTypography = { font: value.font, size }
  if (typeof value.variant === "string" && FONT_VARIANT.test(value.variant)) {
    typography.variant = value.variant
  }
  return typography
}

export function normalizeFormTheme(
  value: unknown,
  allowedFonts?: readonly string[]
): FormTheme {
  if (!isRecord(value)) {
    return { ...DEFAULT_FORM_THEME, typography: defaultTypography() }
  }
  const preset =
    typeof value.preset === "string" &&
    PRESETS.has(value.preset as FormThemePreset)
      ? (value.preset as FormThemePreset)
      : DEFAULT_FORM_THEME.preset
  const theme: FormTheme = {
    preset,
    accentColor: isHexColor(value.accentColor)
      ? value.accentColor.toLowerCase()
      : DEFAULT_FORM_THEME.accentColor,
    backgroundColor: isHexColor(value.backgroundColor)
      ? value.backgroundColor.toLowerCase()
      : DEFAULT_FORM_THEME.backgroundColor,
    typography: isRecord(value.typography)
      ? {
          header: normalizeTypographyRole(
            value.typography.header,
            "header",
            allowedFonts
          ),
          question: normalizeTypographyRole(
            value.typography.question,
            "question",
            allowedFonts
          ),
          text: normalizeTypographyRole(
            value.typography.text,
            "text",
            allowedFonts
          ),
        }
      : {
          header: {
            ...DEFAULT_TYPOGRAPHY.header,
            font: isAllowedFont(value.headingFont, allowedFonts)
              ? value.headingFont
              : DEFAULT_TYPOGRAPHY.header.font,
          },
          question: { ...DEFAULT_TYPOGRAPHY.question },
          text: { ...DEFAULT_TYPOGRAPHY.text },
        },
    allowDarkMode: value.allowDarkMode === true,
    layout: value.layout === "focus" ? "focus" : "classic",
  }
  return theme
}

type FormThemeStyle = CSSProperties & {
  "--form-accent": string
  "--form-accent-foreground": string
  "--form-page-background": string
  "--form-header-font": string
  "--form-header-size": string
  "--form-question-font": string
  "--form-question-size": string
  "--form-text-font": string
  "--form-text-size": string
  "--background": string
  "--foreground": string
  "--card": string
  "--card-foreground": string
  "--border": string
  "--input": string
  "--muted": string
  "--muted-foreground": string
  "--card-muted-foreground": string
  "--primary": string
  "--primary-foreground": string
  "--secondary": string
  "--secondary-foreground": string
  "--ring": string
  colorScheme: "light" | "dark"
}

function toFontStack(font: string): string {
  return `'${font.replaceAll("'", "")}', var(--font-heading)`
}

type TypographyVariantProperties = Partial<
  Record<`--form-${TypographyRole}-${"weight" | "style"}`, string>
>

function variantProperties(
  typography: FormTheme["typography"]
): TypographyVariantProperties {
  const properties: TypographyVariantProperties = {}
  for (const role of ["header", "question", "text"] as const) {
    const variant = typography[role].variant
    if (variant === undefined) continue
    const { weight, italic } = parseFontVariant(variant)
    properties[`--form-${role}-weight`] = String(weight)
    properties[`--form-${role}-style`] = italic ? "italic" : "normal"
  }
  return properties
}

/**
 * Data attributes naming which roles carry a chosen variant, for the surface
 * to set. The CSS applies a role's weight and style only under its attribute,
 * so a role with no choice keeps the weights its elements already set.
 */
export function getFormVariantAttributes(
  themeValue: unknown
): Record<string, "true"> {
  const theme = normalizeFormTheme(themeValue)
  const attributes: Record<string, "true"> = {}
  for (const role of ["header", "question", "text"] as const) {
    if (theme.typography[role].variant !== undefined) {
      attributes[`data-${role}-variant`] = "true"
    }
  }
  return attributes
}

export function getFormThemeStyle(
  themeValue: unknown,
  mode: FormRenderMode = "light"
): FormThemeStyle {
  const theme = normalizeFormTheme(themeValue)
  const dark = theme.allowDarkMode && mode === "dark"
  // Dark surfaces are the chosen page background at low lightness, not one
  // fixed dark palette shared by every theme: Ocean's dark form is a deep
  // blue-gray, Terracotta's a warm one, and a creator who picks a teal page
  // gets a dark teal. Relative color syntax keeps the background's hue and
  // clamps its chroma: a floor so the presets' pale backgrounds still carry
  // their hue, a cap so a saturated custom color reads as atmosphere rather
  // than as a wall of color.
  const tinted = (lightness: number, chromaCap: number) =>
    `oklch(from ${theme.backgroundColor} ${lightness} clamp(0.015, c, ${chromaCap}) h)`
  const pageBackground = dark ? tinted(0.18, 0.06) : theme.backgroundColor
  // A creator may pick a dark page background while leaving dark mode off.
  // Cards stay white in light mode, so their text stays dark, but anything
  // sitting directly on the page (labels, the builder's view toggle, the add
  // question affordance) has to flip to light or it vanishes into the page.
  const cardForeground = dark
    ? `oklch(from ${theme.backgroundColor} 0.97 min(c, 0.008) h)`
    : "oklch(0.145 0 0)"
  const pageIsDark =
    !dark && getAccentForeground(theme.backgroundColor) === LIGHT_FOREGROUND
  const foreground = pageIsDark ? LIGHT_FOREGROUND : cardForeground
  const card = dark ? tinted(0.23, 0.045) : "oklch(1 0 0)"
  const line = dark ? tinted(0.35, 0.045) : "oklch(0.922 0 0)"
  const muted = dark ? tinted(0.28, 0.04) : "oklch(0.97 0 0)"
  // A preset accent is chosen for light backgrounds and can sit near L 0.45;
  // on a dark surface it needs lifting to stay legible, so the floor raises
  // it without touching hue or chroma. Anything at or above the floor takes
  // dark text, which is what getAccentForeground would choose for it too.
  const accent = dark
    ? `oklch(from ${theme.accentColor} max(l, 0.74) c h)`
    : theme.accentColor
  const accentForeground = dark
    ? DARK_FOREGROUND
    : getAccentForeground(theme.accentColor)
  const cardMutedBlendPartner = dark ? cardForeground : "oklch(0.52 0 0)"
  // Page-level muted text blends against whatever the page foreground is, so
  // it stays readable on a dark page; card-level muted text keeps the blend
  // tuned for white cards (see the contrast notes below). A CSS rule scopes
  // the card variant to every .bg-card, so components need not know.
  const pageMutedBlendPartner = pageIsDark ? foreground : cardMutedBlendPartner
  return {
    "--form-accent": accent,
    "--form-accent-foreground": accentForeground,
    "--form-page-background": pageBackground,
    "--form-header-font": toFontStack(theme.typography.header.font),
    "--form-header-size": `${theme.typography.header.size}px`,
    "--form-question-font": toFontStack(theme.typography.question.font),
    "--form-question-size": `${theme.typography.question.size}px`,
    "--form-text-font": toFontStack(theme.typography.text.font),
    "--form-text-size": `${theme.typography.text.size}px`,
    ...variantProperties(theme.typography),
    "--background": pageBackground,
    "--foreground": foreground,
    "--card": card,
    "--card-foreground": cardForeground,
    "--border": line,
    "--input": line,
    "--muted": muted,
    // Blended from this theme's own accent color (rather than a fixed neutral
    // gray) so "muted" text carries each preset's hue instead of reading as
    // plain gray. Most presets' page backgrounds are too desaturated on their
    // own to shift a blend noticeably, so the accent color (always meaningfully
    // saturated) is what actually makes this adapt.
    //
    // The majority partner is asymmetric, and deliberately so. An accent color
    // is dark in both modes, so blending it against dark mode's near-white
    // foreground pulls the result down to roughly L 0.72, right where muted
    // text belongs. Doing the same against light mode's near-black foreground
    // barely moves it, landing near L 0.28, which is body-text weight: muted
    // helper text and placeholders would read as real content. Light therefore
    // blends against a fixed mid gray instead.
    //
    // That gray is 0.52, and the number is a contrast floor rather than a
    // taste call. It was 0.72, which produced a result near L 0.58 that failed
    // WCAG AA against every one of the six preset page backgrounds: forest
    // 3.34, ocean 3.19, plum 3.16, graphite 3.35, sunflower 2.95, terracotta
    // 2.94, against the 4.5 a normal-size body needs. Muted text is not
    // decoration here; it carries input placeholders, the shortcut hints, and
    // the reason a submit button is disabled. At 0.52 the worst preset
    // (terracotta) reaches 4.62 and the rest sit between 4.64 and 5.30, while
    // every result stays near L 0.5, comfortably lighter than the L 0.145
    // foreground, so the hierarchy that made this a blend in the first place
    // still reads. Re-check all six if either the partner or the 45% share
    // moves: presets differ by up to 0.7 in the resulting ratio, so a value
    // that looks fine on forest can fail on terracotta.
    "--muted-foreground": `color-mix(in oklch, ${theme.accentColor} 45%, ${pageMutedBlendPartner} 55%)`,
    "--card-muted-foreground": `color-mix(in oklch, ${theme.accentColor} 45%, ${cardMutedBlendPartner} 55%)`,
    "--primary": accent,
    "--primary-foreground": accentForeground,
    "--secondary": muted,
    "--secondary-foreground": dark ? cardForeground : "oklch(0.205 0 0)",
    "--ring": accent,
    colorScheme: dark ? "dark" : "light",
  }
}
