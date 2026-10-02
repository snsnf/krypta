import { cookies, headers } from "next/headers"
import { LOCALE_COOKIE, resolveAppLanguage, type AppLanguage } from "./app-locale"

/** Server only: reads the request. Client code gets the language from context. */
export async function getAppLanguage(): Promise<AppLanguage> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])
  return resolveAppLanguage({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  })
}
