"use client"

import { useRouter } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import { Globe02Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { apiFetch } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { useAppLanguage, useAppT } from "@/lib/app-i18n"
import { APP_LANGUAGES, localeCookie, type AppLanguage } from "@/lib/app-locale"
import {
  FORM_LANGUAGE_LABELS,
  normalizeFormLanguage,
} from "@/lib/form-language"

/**
 * Remembers an explicit choice and re-renders from the server, which reads the
 * cookie for `<html lang dir>`. Nothing is written until someone picks.
 */
function chooseLanguage(
  language: AppLanguage,
  router: { refresh: () => void }
) {
  document.cookie = localeCookie(
    language,
    window.location.protocol === "https:"
  )
  // A signed-in account keeps its mail in the language it picked. Best
  // effort: the page language has already changed, and a failure here only
  // means the next email is in the previous one.
  if (useAuthStore.getState().userId !== null) {
    void apiFetch("/auth/language", {
      method: "PATCH",
      body: JSON.stringify({ language }),
    }).catch(() => undefined)
  }
  router.refresh()
}

/** Signed-out screens: a text button naming the other language. */
export function AuthLanguageToggle() {
  const router = useRouter()
  const t = useAppT()
  const other: AppLanguage = useAppLanguage() === "ar" ? "en" : "ar"
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`${t("header.language")}: ${FORM_LANGUAGE_LABELS[other]}`}
      onClick={() => chooseLanguage(other, router)}
      className="absolute end-4 top-4"
    >
      <HugeiconsIcon icon={Globe02Icon} size={14} data-icon="inline-start" />
      <span lang={other}>{FORM_LANGUAGE_LABELS[other]}</span>
    </Button>
  )
}

/** Header, from `sm` up: an icon-only menu beside the theme toggle. */
export function LanguageMenu() {
  const t = useAppT()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("header.language")}
            className="text-muted-foreground"
          />
        }
      >
        <HugeiconsIcon icon={Globe02Icon} size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <LanguageRadioItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The choice itself: inside the mobile account menu and the header globe menu. */
export function LanguageRadioItems() {
  const router = useRouter()
  const current = useAppLanguage()
  return (
    <DropdownMenuRadioGroup
      value={current}
      onValueChange={(value) =>
        chooseLanguage(normalizeFormLanguage(value), router)
      }
    >
      {APP_LANGUAGES.map((language) => (
        <DropdownMenuRadioItem
          key={language}
          value={language}
          lang={language}
          // Radio items stay open by default; choosing a language reloads
          // the page's text, so the menu should get out of the way.
          closeOnClick
        >
          {FORM_LANGUAGE_LABELS[language]}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}
