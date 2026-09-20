import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { legalIdentity } from "./legal"

const KEYS = ["LEGAL_ENTITY", "LEGAL_CONTACT_EMAIL"] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("legalIdentity", () => {
  test("an instance that has named nobody has no identity", () => {
    expect(legalIdentity()).toBeNull()
  })

  test("names the operator and how to reach them", () => {
    process.env.LEGAL_ENTITY = "Example Lda"
    process.env.LEGAL_CONTACT_EMAIL = "privacy@example.com"
    expect(legalIdentity()).toEqual({
      entity: "Example Lda",
      contactEmail: "privacy@example.com",
    })
  })

  test("an entity with no contact address is not enough", () => {
    // A policy naming a company with no way to reach it fails the one thing a
    // reader needs it for.
    process.env.LEGAL_ENTITY = "Example Lda"
    expect(legalIdentity()).toBeNull()
  })

  test("a contact address with no entity is not enough", () => {
    process.env.LEGAL_CONTACT_EMAIL = "privacy@example.com"
    expect(legalIdentity()).toBeNull()
  })

  test("blank and whitespace-only values count as unset", () => {
    // An operator who clears one of these in their env file, or leaves the
    // template's empty value in place, must get no page rather than a page
    // with a hole where the company name goes.
    process.env.LEGAL_ENTITY = "   "
    process.env.LEGAL_CONTACT_EMAIL = "privacy@example.com"
    expect(legalIdentity()).toBeNull()
  })

  test("trims the values, since env files carry stray spaces", () => {
    process.env.LEGAL_ENTITY = "  Example Lda  "
    process.env.LEGAL_CONTACT_EMAIL = " privacy@example.com "
    expect(legalIdentity()).toEqual({
      entity: "Example Lda",
      contactEmail: "privacy@example.com",
    })
  })
})
