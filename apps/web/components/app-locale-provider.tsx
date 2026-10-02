"use client"

import type { ReactNode } from "react"
import { DirectionProvider } from "@base-ui/react/direction-provider"
import { AppLanguageContext } from "@/lib/app-i18n"
import { formDirection } from "@/lib/form-language"
import type { AppLanguage } from "@/lib/app-locale"

/*
 * The app's language and direction for everything beneath it. Base UI reads
 * direction from its own provider (its portalled menus and dialogs do not
 * inherit it from the DOM), so both are set here, once.
 */
export function AppLocaleProvider({
  language,
  children,
}: {
  language: AppLanguage
  children: ReactNode
}) {
  return (
    <AppLanguageContext value={language}>
      <DirectionProvider direction={formDirection(language)}>
        {children}
      </DirectionProvider>
    </AppLanguageContext>
  )
}
