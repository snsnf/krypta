/*
 * Pure helpers with no React and no messages, so the theme normaliser (and any
 * server module that reaches it) can use them without pulling in a context.
 */

/*
 * The form's language: what respondents see around the questions, chosen by
 * the creator and stored in the encrypted theme. Not the app's language,
 * which is whoever is using the dashboard. The creator's own questions are
 * never translated.
 */
export const FORM_LANGUAGES = ["en", "ar"] as const
export type FormLanguage = (typeof FORM_LANGUAGES)[number]

export const FORM_LANGUAGE_LABELS: Record<FormLanguage, string> = {
  en: "English",
  ar: "العربية",
}

const RIGHT_TO_LEFT = new Set<FormLanguage>(["ar"])

export function normalizeFormLanguage(value: unknown): FormLanguage {
  return FORM_LANGUAGES.includes(value as FormLanguage)
    ? (value as FormLanguage)
    : "en"
}

export function formDirection(language: FormLanguage): "ltr" | "rtl" {
  return RIGHT_TO_LEFT.has(language) ? "rtl" : "ltr"
}
