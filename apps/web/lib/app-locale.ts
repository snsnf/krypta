import { FORM_LANGUAGES, type FormLanguage } from "./form-language"

/*
 * The app's language: the viewer's, for the dashboard, builder and the screens
 * around signing in. Not the form's language (see form-language.ts), which is
 * the creator's choice and what respondents see. The supported set is the
 * same pair today.
 */
export const APP_LANGUAGES = FORM_LANGUAGES
export type AppLanguage = FormLanguage

export const LOCALE_COOKIE = "krypta-locale"
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

function supported(value: string | null | undefined): AppLanguage | null {
  return (APP_LANGUAGES as readonly string[]).includes(value ?? "")
    ? (value as AppLanguage)
    : null
}

/** The first supported language by q-value, ignoring region ("ar-SA" is "ar"). */
export function parseAcceptLanguage(
  header: string | null | undefined
): AppLanguage | null {
  if (!header) return null
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";")
      const q = params
        .map((p) => p.trim())
        .find((p) => p.toLowerCase().startsWith("q="))
      const weight = q === undefined ? 1 : Number(q.slice(2))
      return {
        primary: tag.trim().toLowerCase().split("-")[0],
        weight: Number.isFinite(weight) ? weight : 0,
        index,
      }
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  for (const entry of ranked) {
    const language = supported(entry.primary)
    if (language !== null) return language
  }
  return null
}

/*
 * Routes whose content is still English only. The browser's language
 * preference does not apply there, because it would mirror English text right
 * to left; an explicit choice (the cookie) still does. Each stage that
 * translates a route removes it from this list. "/" is the landing page alone.
 */
const UNTRANSLATED_ROUTES = [
  "/",
  "/admin",
  "/privacy",
  "/terms",
  "/security",
]

// Public forms take the form's own language, never the viewer's.
const ALWAYS_ENGLISH_ROUTES = ["/f"]

function onRoute(pathname: string, route: string): boolean {
  return route === "/"
    ? pathname === "/"
    : pathname === route || pathname.startsWith(`${route}/`)
}

export function isUntranslatedRoute(pathname: string): boolean {
  return UNTRANSLATED_ROUTES.some((route) => onRoute(pathname, route))
}

export function resolveAppLanguage(input: {
  cookie?: string | null
  acceptLanguage?: string | null
  /** The request path, when known (the proxy forwards it as x-pathname). */
  pathname?: string | null
}): AppLanguage {
  const { pathname } = input
  if (pathname && ALWAYS_ENGLISH_ROUTES.some((route) => onRoute(pathname, route))) {
    return "en"
  }
  const chosen = supported(input.cookie)
  if (chosen !== null) return chosen
  if (pathname && isUntranslatedRoute(pathname)) return "en"
  return parseAcceptLanguage(input.acceptLanguage) ?? "en"
}

/**
 * The cookie remembering an explicit choice. A preference, not a credential,
 * so it is script-readable; it is written only when someone picks a language,
 * never by default, because /privacy promises the only cookies are the ones
 * that sign you in plus this one.
 */
export function localeCookie(language: AppLanguage, secure: boolean): string {
  return (
    `${LOCALE_COOKIE}=${language}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax` +
    (secure ? "; Secure" : "")
  )
}
