import { describe, expect, it } from "vitest"
import { safeAuthReturn } from "./auth-return"

describe("safeAuthReturn", () => {
  it("allows only the invitation continuation route", () => {
    expect(safeAuthReturn("/invitations/accept")).toBe("/invitations/accept")
    expect(safeAuthReturn("/dashboard")).toBe("/dashboard")
    expect(safeAuthReturn("https://evil.example")).toBe("/dashboard")
    expect(safeAuthReturn("//evil.example")).toBe("/dashboard")
    expect(safeAuthReturn("/dashboard/other")).toBe("/dashboard")
    expect(safeAuthReturn("/invitations/accept/child")).toBe("/dashboard")
    expect(safeAuthReturn("/invitations/accept?token=leak")).toBe("/dashboard")
    expect(safeAuthReturn(null)).toBe("/dashboard")
  })
})
