import { describe, expect, it } from "vitest"
import {
  LOCALE_COOKIE,
  isUntranslatedRoute,
  localeCookie,
  parseAcceptLanguage,
  resolveAppLanguage,
} from "./app-locale"

describe("parseAcceptLanguage", () => {
  it("takes the highest-q supported language and ignores variants", () => {
    expect(parseAcceptLanguage("ar-SA,ar;q=0.9,en;q=0.8")).toBe("ar")
    expect(parseAcceptLanguage("en-US,en;q=0.9,ar;q=0.8")).toBe("en")
    expect(parseAcceptLanguage("fr-FR,ar;q=0.5")).toBe("ar")
    expect(parseAcceptLanguage("AR-eg")).toBe("ar")
  })

  it("returns null when nothing supported is offered or q is zero", () => {
    expect(parseAcceptLanguage("fr-FR,de;q=0.8")).toBeNull()
    expect(parseAcceptLanguage("ar;q=0")).toBeNull()
    expect(parseAcceptLanguage("*")).toBeNull()
    expect(parseAcceptLanguage("")).toBeNull()
    expect(parseAcceptLanguage(null)).toBeNull()
    expect(parseAcceptLanguage(";;;,,q=")).toBeNull()
  })
})

describe("resolveAppLanguage", () => {
  it("prefers the cookie, then Accept-Language, then English", () => {
    expect(resolveAppLanguage({ cookie: "en", acceptLanguage: "ar" })).toBe("en")
    expect(resolveAppLanguage({ cookie: "ar", acceptLanguage: "en" })).toBe("ar")
    expect(resolveAppLanguage({ acceptLanguage: "ar-SA" })).toBe("ar")
    expect(resolveAppLanguage({})).toBe("en")
  })

  it("ignores a cookie it does not recognise", () => {
    expect(resolveAppLanguage({ cookie: "xx", acceptLanguage: "ar" })).toBe("ar")
    expect(resolveAppLanguage({ cookie: "", acceptLanguage: null })).toBe("en")
    expect(resolveAppLanguage({ cookie: "__proto__" })).toBe("en")
  })
})

describe("localeCookie", () => {
  it("is a year-long first-party preference, Secure only over https", () => {
    expect(localeCookie("ar", false)).toBe(
      `${LOCALE_COOKIE}=ar; Path=/; Max-Age=31536000; SameSite=Lax`
    )
    expect(localeCookie("en", true)).toBe(
      `${LOCALE_COOKIE}=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
    )
  })
})

describe("route-aware resolution", () => {
  const ar = "ar-SA,ar;q=0.9"

  it("applies the browser's language only where the screen is translated", () => {
    expect(resolveAppLanguage({ acceptLanguage: ar, pathname: "/login" })).toBe("ar")
    expect(resolveAppLanguage({ acceptLanguage: ar, pathname: "/recover" })).toBe("ar")
    // An unknown path is a 404, which is translated.
    expect(resolveAppLanguage({ acceptLanguage: ar, pathname: "/no-such-page" })).toBe("ar")
    for (const pathname of ["/", "/dashboard", "/dashboard/abc", "/admin/health", "/privacy", "/terms", "/security", "/invitations/accept"]) {
      expect(resolveAppLanguage({ acceptLanguage: ar, pathname }), pathname).toBe("en")
    }
  })

  it("still honours an explicit choice on an untranslated route", () => {
    expect(resolveAppLanguage({ cookie: "ar", pathname: "/dashboard" })).toBe("ar")
    expect(resolveAppLanguage({ cookie: "ar", pathname: "/" })).toBe("ar")
  })

  it("never applies any app language to a public form", () => {
    expect(resolveAppLanguage({ cookie: "ar", acceptLanguage: ar, pathname: "/f/abc" })).toBe("en")
    expect(resolveAppLanguage({ acceptLanguage: ar, pathname: "/f/abc/r" })).toBe("en")
    // A path that merely starts with the same letter is not a form.
    expect(resolveAppLanguage({ acceptLanguage: ar, pathname: "/forms-are-great" })).toBe("ar")
  })

  it("does not mistake a prefix match for a route", () => {
    expect(isUntranslatedRoute("/dashboard")).toBe(true)
    expect(isUntranslatedRoute("/dashboards")).toBe(false)
    expect(isUntranslatedRoute("/login")).toBe(false)
  })

  it("behaves as before when the path is unknown", () => {
    expect(resolveAppLanguage({ acceptLanguage: ar })).toBe("ar")
  })
})
