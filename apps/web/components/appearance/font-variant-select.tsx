"use client"

import { useEffect, useState } from "react"
import { fontVariantLabel, parseFontVariant } from "@/lib/form-theme"
import { useAppT } from "@/lib/app-i18n"
import { loadFontCatalog } from "@/lib/font-catalog-client"

interface FontVariantSelectProps {
  family: string
  /** Absent means the role keeps the weights its elements already set. */
  value: string | undefined
  onChange: (variant: string | undefined) => void
  ariaLabel: string
  className?: string
}

/** Orders variants lightest first, each upright style before its italic. */
function byWeight(a: string, b: string): number {
  const left = parseFontVariant(a)
  const right = parseFontVariant(b)
  return (
    left.weight - right.weight || Number(left.italic) - Number(right.italic)
  )
}

/**
 * The weights and styles the chosen family actually ships, from the same
 * catalogue the font picker reads. Until the catalogue arrives it offers only
 * "Default" and the current choice, so a stored variant never disappears
 * from its own control.
 */
export function FontVariantSelect({
  family,
  value,
  onChange,
  ariaLabel,
  className,
}: FontVariantSelectProps) {
  const t = useAppT()

  const [variants, setVariants] = useState<string[] | null>(null)

  useEffect(() => {
    let active = true
    loadFontCatalog()
      .then((fonts) => {
        if (!active) return
        const entry = fonts.find((font) => font.family === family)
        setVariants(entry ? [...entry.variants].sort(byWeight) : [])
      })
      .catch(() => {
        if (active) setVariants([])
      })
    return () => {
      active = false
    }
  }, [family])

  const options =
    value !== undefined && !(variants ?? []).includes(value)
      ? [...(variants ?? []), value].sort(byWeight)
      : (variants ?? [])

  return (
    <select
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(event) =>
        onChange(event.target.value === "" ? undefined : event.target.value)
      }
      className={className}
    >
      <option value="">{t("appearance.default")}</option>
      {options.map((variant) => (
        <option key={variant} value={variant}>
          {fontVariantLabel(variant, t)}
        </option>
      ))}
    </select>
  )
}
