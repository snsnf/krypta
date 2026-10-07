"use client"

import { useEffect, useState } from "react"
import { fontVariantLabel, parseFontVariant } from "@/lib/form-theme"
import { useAppT } from "@/lib/app-i18n"
import { loadFontCatalog } from "@/lib/font-catalog-client"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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
  // The theme's own weight is no variant at all, so it is the null item.
  const items: { value: string | null; label: string }[] = [
    { value: null, label: t("appearance.default") },
    ...options.map((variant) => ({
      value: variant,
      label: fontVariantLabel(variant, t),
    })),
  ]

  return (
    <Select
      items={items}
      value={value ?? null}
      onValueChange={(next) => onChange(next ?? undefined)}
    >
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value ?? ""} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
