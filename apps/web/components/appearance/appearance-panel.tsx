"use client"

import { useEffect, useRef, useState } from "react"
import type { FormTheme, FormThemePreset } from "@krypta/crypto"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { ColorField } from "@/components/appearance/color-field"
import { FontPicker } from "@/components/appearance/font-picker"
import { FontVariantSelect } from "@/components/appearance/font-variant-select"
import {
  FORM_TYPOGRAPHY_SIZES,
  FORM_THEME_PRESETS,
  getAccentForeground,
  getContrastRatio,
} from "@/lib/form-theme"
import { cn } from "@/lib/utils"
import { translateKey, useAppT } from "@/lib/app-i18n"
import {
  FORM_LANGUAGES,
  FORM_LANGUAGE_LABELS,
  normalizeFormLanguage,
} from "@/lib/form-language"

/**
 * Absent means this form cannot take an image yet, which is true before it has
 * been saved: the bytes are stored against a form id that does not exist.
 */
export interface HeaderImageControls {
  /** Object URL for the decrypted image, or null when there is none. */
  previewUrl: string | null
  busy: boolean
  error: string | null
  onSelect: (file: File) => void
  onRemove: () => void
}

interface AppearancePanelProps {
  value: FormTheme
  onChange: (theme: FormTheme) => void
  idPrefix?: string
  headerImage?: HeaderImageControls | null
}

type TypographyRole = keyof FormTheme["typography"]

const TYPOGRAPHY_ROLES: TypographyRole[] = ["header", "question", "text"]

export function AppearancePanel({
  value,
  onChange,
  idPrefix = "",
  headerImage = null,
}: AppearancePanelProps) {
  const t = useAppT()
  const presetName = (preset: Exclude<FormThemePreset, "custom">) =>
    translateKey(t, `appearance.presetNames.${preset}`)
  const roleName = (role: TypographyRole) =>
    translateKey(t, `appearance.roles.${role}`)
  const [announcement, setAnnouncement] = useState("")
  const imageInputRef = useRef<HTMLInputElement>(null)
  const previousColors = useRef({
    accentColor: value.accentColor,
    backgroundColor: value.backgroundColor,
  })

  useEffect(() => {
    const previous = previousColors.current
    if (
      previous.accentColor === value.accentColor &&
      previous.backgroundColor === value.backgroundColor
    ) {
      return
    }
    previousColors.current = {
      accentColor: value.accentColor,
      backgroundColor: value.backgroundColor,
    }
    const timeout = window.setTimeout(() => {
      setAnnouncement(t("appearance.colorsUpdated"))
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [value.accentColor, value.backgroundColor])

  function selectPreset(preset: Exclude<FormThemePreset, "custom">) {
    onChange({
      ...value,
      preset,
      ...FORM_THEME_PRESETS[preset],
    })
    setAnnouncement(t("appearance.themeSelected", { name: presetName(preset) }))
  }

  function selectLayout(layout: NonNullable<FormTheme["layout"]>) {
    onChange({ ...value, layout })
    setAnnouncement(
      layout === "focus"
        ? t("appearance.focusSelected")
        : t("appearance.classicSelected")
    )
  }

  function updateColor(
    field: "accentColor" | "backgroundColor",
    color: string
  ) {
    onChange({ ...value, preset: "custom", [field]: color })
  }

  function updateTypography(
    role: TypographyRole,
    patch: Partial<FormTheme["typography"][TypographyRole]>
  ) {
    const typography = {
      ...value.typography,
      [role]: { ...value.typography[role], ...patch },
    }
    onChange({ ...value, typography })
    setAnnouncement(t("appearance.textStyleUpdated", { role: roleName(role) }))
  }

  function updateDarkMode(allowDarkMode: boolean) {
    onChange({ ...value, allowDarkMode })
    setAnnouncement(
      allowDarkMode ? t("appearance.darkOn") : t("appearance.darkOff")
    )
  }

  const accentForeground = getAccentForeground(value.accentColor)
  const accentContrast = getContrastRatio(value.accentColor, accentForeground)

  return (
    <div className="space-y-5">
      <h2 className="text-base font-medium">{t("appearance.title")}</h2>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("appearance.layout")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            aria-label={t("appearance.classicAria")}
            aria-pressed={(value.layout ?? "classic") === "classic"}
            onClick={() => selectLayout("classic")}
            className={cn(
              "rounded-lg border px-3 py-2 text-start text-xs transition-colors",
              (value.layout ?? "classic") === "classic"
                ? "border-foreground bg-muted"
                : "border-border hover:bg-muted"
            )}
          >
            <p className="font-medium">{t("appearance.classic")}</p>
            <p className="mt-0.5 text-muted-foreground">
              {t("appearance.classicBody")}
            </p>
          </button>
          <button
            type="button"
            aria-label={t("appearance.focusAria")}
            aria-pressed={value.layout === "focus"}
            onClick={() => selectLayout("focus")}
            className={cn(
              "rounded-lg border px-3 py-2 text-start text-xs transition-colors",
              value.layout === "focus"
                ? "border-foreground bg-muted"
                : "border-border hover:bg-muted"
            )}
          >
            <p className="font-medium">{t("appearance.focus")}</p>
            <p className="mt-0.5 text-muted-foreground">
              {t("appearance.focusBody")}
            </p>
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}form-language`}>
          {t("appearance.language")}
        </Label>
        <select
          id={`${idPrefix}form-language`}
          value={normalizeFormLanguage(value.language)}
          onChange={(event) => {
            const language = normalizeFormLanguage(event.target.value)
            // English is the absence of a language, so an English form
            // serialises exactly as it did before languages existed.
            onChange({
              ...value,
              language: language === "en" ? undefined : language,
            })
          }}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          {FORM_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {FORM_LANGUAGE_LABELS[language]}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t("appearance.languageBody")}
        </p>
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("appearance.presets")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(
            Object.entries(FORM_THEME_PRESETS) as [
              Exclude<FormThemePreset, "custom">,
              { accentColor: string; backgroundColor: string },
            ][]
          ).map(([preset, colors]) => (
            <button
              key={preset}
              type="button"
              aria-label={t("appearance.themeAria", {
                name: presetName(preset),
              })}
              aria-pressed={value.preset === preset}
              onClick={() => selectPreset(preset)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2 py-2 text-start text-xs transition-colors",
                value.preset === preset
                  ? "border-foreground bg-muted"
                  : "border-border hover:bg-muted"
              )}
            >
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full border border-black/10"
                style={{ backgroundColor: colors.accentColor }}
              />
              {presetName(preset)}
            </button>
          ))}
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        <ColorField
          id={`${idPrefix}accent-color`}
          label={t("appearance.accent")}
          value={value.accentColor}
          onValidChange={(color) => updateColor("accentColor", color)}
        />
        <div>
          <div
            className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium"
            style={{
              backgroundColor: value.accentColor,
              color: accentForeground,
            }}
          >
            {t("appearance.buttonPreview")}
          </div>
          {accentContrast < 4.5 && (
            <p className="mt-1 text-xs text-destructive">
              {t("appearance.lowContrast")}
            </p>
          )}
        </div>
        <ColorField
          id={`${idPrefix}background-color`}
          label={t("appearance.background")}
          value={value.backgroundColor}
          onValidChange={(color) => updateColor("backgroundColor", color)}
        />
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t("appearance.textStyle")}</h3>
        <div className="space-y-3">
          {TYPOGRAPHY_ROLES.map((role) => (
            <div key={role} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {roleName(role)}
              </p>
              <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                <div className="col-span-2">
                  <FontPicker
                    value={value.typography[role].font}
                    // A variant belongs to the family it was picked from; a
                    // new family starts from its default weights.
                    onChange={(font) =>
                      updateTypography(role, { font, variant: undefined })
                    }
                    ariaLabel={t("appearance.fontAria", {
                      role: roleName(role),
                    })}
                  />
                </div>
                <FontVariantSelect
                  family={value.typography[role].font}
                  value={value.typography[role].variant}
                  onChange={(variant) => updateTypography(role, { variant })}
                  ariaLabel={t("appearance.weightAria", {
                    role: roleName(role),
                  })}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <select
                  aria-label={t("appearance.sizeAria", {
                    role: roleName(role),
                  })}
                  value={value.typography[role].size}
                  onChange={(event) =>
                    updateTypography(role, {
                      size: Number(event.target.value),
                    })
                  }
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {FORM_TYPOGRAPHY_SIZES[role].map((size) => (
                    <option key={size} value={size}>
                      {size}px
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}allow-dark-mode`}>
            {t("appearance.allowDark")}
          </Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("appearance.allowDarkBody")}
          </p>
        </div>
        <Switch
          id={`${idPrefix}allow-dark-mode`}
          aria-label={t("appearance.allowDark")}
          checked={value.allowDarkMode ?? false}
          onCheckedChange={updateDarkMode}
        />
      </div>

      <Separator />

      {/*
       * Uploaded rather than linked. A URL made every respondent's browser
       * fetch a third party, which handed that host their IP on a form that may
       * be collecting exactly what encryption is for, and the creator who
       * pasted the link could not see it happening. An uploaded image is
       * encrypted under this form's schema key like everything else.
       */}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}header-image`}>
          {t("appearance.headerImage")}
        </Label>
        {headerImage ? (
          <>
            <input
              ref={imageInputRef}
              id={`${idPrefix}header-image`}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) headerImage.onSelect(file)
                // Cleared so choosing the same file twice still fires a change.
                event.target.value = ""
              }}
            />
            {headerImage.previewUrl && (
              <div className="aspect-[4/1] overflow-hidden rounded-lg bg-muted">
                {/* An object URL for bytes decrypted in this page, so next/image
                    has nothing to optimise and would only add a proxy hop. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={headerImage.previewUrl}
                  alt={t("appearance.headerPreview")}
                  className="h-full w-full object-cover"
                />
              </div>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={headerImage.busy}
                onClick={() => imageInputRef.current?.click()}
              >
                {headerImage.busy
                  ? t("appearance.uploading")
                  : headerImage.previewUrl
                    ? t("appearance.replace")
                    : t("appearance.upload")}
              </Button>
              {headerImage.previewUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={headerImage.busy}
                  onClick={headerImage.onRemove}
                >
                  {t("common.remove")}
                </Button>
              )}
            </div>
            {headerImage.error && (
              <p className="text-xs text-destructive" aria-live="polite">
                {headerImage.error}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("appearance.saveFirst")}
          </p>
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("appearance.footnote")}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
