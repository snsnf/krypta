import { describe, expect, it } from "vitest"
import {
  LOCALE_COOKIE,
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
