"use client"

import { useEffect, useState, type ReactNode } from "react"
import type { FormTheme } from "@krypta/crypto"
import {
  DEFAULT_FORM_BUNDLED_FONTS,
  DEFAULT_FORM_THEME,
  type FormRenderMode,
  getFormThemeStyle,
  getFormVariantAttributes,
  getFontCssUrl,
  normalizeFormTheme,
} from "@/lib/form-theme"
import type { FontCatalogEntry } from "@/lib/fonts"
import { loadFontCatalog } from "@/lib/font-catalog-client"
import { cn } from "@/lib/utils"
import {
  FormLanguageContext,
  formDirection,
  normalizeFormLanguage,
  useFormT,
} from "@/lib/form-i18n"

// A child of the context provider, so it is worded in the form's language.
function FontFailedNote() {
  return <>{useFormT()("fontFailed")}</>
}

interface FormThemeSurfaceProps {
  theme: FormTheme
  children: ReactNode
  className?: string
  mode?: FormRenderMode
  /**
   * False where the surface frames app chrome rather than a respondent's
   * view (the builder workspace, a member's read-only view): the form's fonts
   * and colours still apply, but direction, language and the respondent
   * strings stay the app's, which is English for now.
   */
  applyLanguage?: boolean
}

const TYPOGRAPHY_ROLES = ["header", "question", "text"] as const

/** Splits a joined font key back into families, tolerating the empty case. */
function familiesFromKey(key: string): string[] {
  return key === "" ? [] : key.split("\u0000")
}

export function FormThemeSurface({
  theme: rawTheme,
  children,
  className,
  mode = "light",
  applyLanguage = true,
}: FormThemeSurfaceProps) {
  const [catalog, setCatalog] = useState<readonly FontCatalogEntry[] | null>(
    null
  )
  const [fontFailures, setFontFailures] = useState<Set<string>>(() => new Set())
  const theme = normalizeFormTheme(rawTheme)
  const language = applyLanguage ? normalizeFormLanguage(theme.language) : "en"
  const selectedFamilies = [
    ...new Set(TYPOGRAPHY_ROLES.map((role) => theme.typography[role].font)),
  ]
  const externalFamilies = selectedFamilies.filter(
    (family) =>
      !DEFAULT_FORM_BUNDLED_FONTS.includes(
        family as (typeof DEFAULT_FORM_BUNDLED_FONTS)[number]
      )
  )
  const externalFamiliesKey = externalFamilies.join("\u0000")
  const approvedExternalFamilies = externalFamilies.filter(
    (family) =>
      catalog?.some((entry) => entry.family === family) &&
      !fontFailures.has(family)
  )
  const approvedExternalFamiliesKey = approvedExternalFamilies.join("\u0000")
  const isApprovedFamily = (family: string) =>
    DEFAULT_FORM_BUNDLED_FONTS.includes(
      family as (typeof DEFAULT_FORM_BUNDLED_FONTS)[number]
    ) ||
    (catalog?.some((entry) => entry.family === family) &&
      !fontFailures.has(family))
  const themedSurface: FormTheme = {
    ...theme,
    typography: Object.fromEntries(
      TYPOGRAPHY_ROLES.map((role) => [
        role,
        {
          ...theme.typography[role],
          font: isApprovedFamily(theme.typography[role].font)
            ? theme.typography[role].font
            : DEFAULT_FORM_THEME.typography[role].font,
        },
      ])
    ) as FormTheme["typography"],
  }
  const renderMode: FormRenderMode =
    themedSurface.allowDarkMode && mode === "dark" ? "dark" : "light"
  const fontError = externalFamilies.some(
    (family) =>
      fontFailures.has(family) ||
      (catalog !== null && !catalog.some((entry) => entry.family === family))
  )

  useEffect(() => {
    // Derived here rather than closed over: `externalFamilies` is a fresh array
    // every render, so depending on it would re-run this on each one. The key is
    // the stable identity, and splitting it back is exact.
    const families = familiesFromKey(externalFamiliesKey)
    if (families.length === 0 || catalog !== null) return

    let active = true
    void loadFontCatalog()
      .then((fonts) => {
        if (active) {
          setCatalog(fonts)
        }
      })
      .catch(() => {
        if (active) {
          setFontFailures((failures) => new Set([...failures, ...families]))
        }
      })

    return () => {
      active = false
    }
  }, [catalog, externalFamiliesKey])

  useEffect(() => {
    const links: HTMLLinkElement[] = []
    for (const family of familiesFromKey(approvedExternalFamiliesKey)) {
      const href = getFontCssUrl(family, catalog ?? [])
      if (!href) continue
      const link = document.createElement("link")
      link.rel = "stylesheet"
      link.href = href
      link.dataset.formTypographyFont = family
      link.addEventListener("error", () =>
        setFontFailures((failures) => new Set(failures).add(family))
      )
      document.head.appendChild(link)
      links.push(link)
    }
    return () => links.forEach((link) => link.remove())
  }, [approvedExternalFamiliesKey, catalog])

  // The Arabic face behind every font stack (see toFontStack), fetched only
  // for Arabic forms and from this origin like every other font.
  useEffect(() => {
    if (language !== "ar") return
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = "/fonts/noto-sans-arabic.css"
    link.dataset.formLanguageFont = language
    document.head.appendChild(link)
    return () => link.remove()
  }, [language])

  return (
    <div
      data-testid="form-theme-surface"
      dir={formDirection(language)}
      lang={language}
      data-form-mode={renderMode}
      className={cn("form-theme-surface", className)}
      style={getFormThemeStyle(themedSurface, renderMode)}
      {...getFormVariantAttributes(themedSurface)}
    >
      <FormLanguageContext value={language}>
        {fontError && (
          <p className="sr-only" role="status">
            <FontFailedNote />
          </p>
        )}
        {children}
      </FormLanguageContext>
    </div>
  )
}
