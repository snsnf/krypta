import { createContext, useContext } from "react"
import { appTranslator, type AppTranslator } from "./app-translator"
import { appFormatters, type AppFormatters } from "./app-format"
import type { AppLanguage } from "./app-locale"

export { appTranslator, translateKey, type AppTranslator } from "./app-translator"

/*
 * The client half: our own context carries the language, and the default is
 * English so a component rendered with no provider (every unit test) renders
 * as it always did. The translator itself is in app-translator.ts, which a
 * Server Component can import because it has no React in it.
 */
export const AppLanguageContext = createContext<AppLanguage>("en")

export function useAppLanguage(): AppLanguage {
  return useContext(AppLanguageContext)
}

export function useAppT(): AppTranslator {
  return appTranslator(useAppLanguage())
}

export function useAppFormat(): AppFormatters {
  return appFormatters(useAppLanguage())
}
