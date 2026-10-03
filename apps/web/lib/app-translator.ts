import { createTranslator } from "next-intl"
import en from "../messages/en.json"
import ar from "../messages/ar.json"
import type { AppLanguage } from "./app-locale"

/*
 * The server-safe half of the app's i18n: no React in here, so a Server
 * Component (not-found.tsx) can use it. The context and hooks that carry the
 * language through client components are in app-i18n.ts.
 *
 * Same pattern as form-i18n.ts: next-intl formats (ICU, plurals, rich text). The
 * respondent `form` section is deliberately left out: it follows the form's
 * language, never the viewer's.
 */
type AppMessages = Omit<typeof en, "form">

function withoutForm(messages: typeof en): AppMessages {
  const { form, ...rest } = messages
  void form
  return rest
}

const MESSAGES: Record<AppLanguage, AppMessages> = {
  en: withoutForm(en),
  ar: withoutForm(ar),
}

function createAppTranslator(language: AppLanguage) {
  // The Unicode extension pins Western digits for every number a message
  // formats (the # in a plural), which is the workspace's rule; see app-format.ts.
  return createTranslator({
    locale: `${language}-u-nu-latn`,
    messages: MESSAGES[language],
  })
}

export type AppTranslator = ReturnType<typeof createAppTranslator>

// One translator per language: formatters are cached inside it.
const TRANSLATORS = new Map<AppLanguage, AppTranslator>()

export function appTranslator(language: AppLanguage): AppTranslator {
  let translator = TRANSLATORS.get(language)
  if (translator === undefined) {
    translator = createAppTranslator(language)
    TRANSLATORS.set(language, translator)
  }
  return translator
}

/**
 * For a key built at run time (a lookup table, a template string). Static call
 * sites use `t("auth.login.title")` and get their keys type-checked; a dynamic
 * one cannot, so message-catalogue.test.ts is what guarantees it exists.
 */
export function translateKey(
  t: AppTranslator,
  key: string,
  values?: Record<string, string | number>
): string {
  return (t as unknown as (key: string, values?: Record<string, string | number>) => string)(
    key,
    values
  )
}
