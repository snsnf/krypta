import { createContext, useContext } from "react"
import { createTranslator } from "next-intl"
import en from "../messages/en.json"
import ar from "../messages/ar.json"

import {
  normalizeFormLanguage,
  formDirection,
  FORM_LANGUAGES,
  FORM_LANGUAGE_LABELS,
  type FormLanguage,
} from "./form-language"

export {
  normalizeFormLanguage,
  formDirection,
  FORM_LANGUAGES,
  FORM_LANGUAGE_LABELS,
  type FormLanguage,
}

const MESSAGES: Record<FormLanguage, typeof en> = { en, ar }

export function formTranslator(language: FormLanguage) {
  return createTranslator({
    locale: language,
    messages: MESSAGES[language],
    namespace: "form",
  })
}

export type FormTranslator = ReturnType<typeof formTranslator>

/*
 * Our own context rather than next-intl's provider: its default is English,
 * so a component rendered without a surface (every existing unit test)
 * behaves exactly as before.
 */
export const FormLanguageContext = createContext<FormLanguage>("en")

export function useFormLanguage(): FormLanguage {
  return useContext(FormLanguageContext)
}

export function useFormT(): FormTranslator {
  return formTranslator(useFormLanguage())
}
