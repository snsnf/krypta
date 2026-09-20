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

interface FormThemeSurfaceProps {
  theme: FormTheme
  children: ReactNode
  className?: string
  mode?: FormRenderMode
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
}: FormThemeSurfaceProps) {
  const [catalog, setCatalog] = useState<readonly FontCatalogEntry[] | null>(
    null
  )
  const [fontFailures, setFontFailures] = useState<Set<string>>(() => new Set())
  const theme = normalizeFormTheme(rawTheme)
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

  return (
    <div
      data-testid="form-theme-surface"
      data-form-mode={renderMode}
      className={cn("form-theme-surface", className)}
      style={getFormThemeStyle(themedSurface, renderMode)}
      {...getFormVariantAttributes(themedSurface)}
    >
      {fontError && (
        <p className="sr-only" role="status">
          A selected font could not be loaded. Using its role default instead.
        </p>
      )}
      {children}
    </div>
  )
}
