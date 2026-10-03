import { describe, expect, it } from "vitest"
import { appFormatters } from "./app-format"

describe("appFormatters", () => {
  it("writes Western digits in both languages", () => {
    expect(appFormatters("en").number(1234567)).toBe("1,234,567")
    expect(appFormatters("ar").number(1234567)).toMatch(/^[0-9٬,.٬\s]+$/)
    expect(appFormatters("ar").number(1234567)).not.toMatch(/[٠-٩]/)
  })

  it("writes Gregorian dates with Arabic month names and no Arabic-Indic digits", () => {
    const date = "2026-03-05T10:00:00Z"
    expect(appFormatters("en").date(date)).toContain("2026")
    const ar = appFormatters("ar").date(date)
    expect(ar).toContain("2026")
    expect(ar).toMatch(/[؀-ۿ]/)
    expect(ar).not.toMatch(/[٠-٩]/)
  })

  it("returns an empty string for an unparseable date", () => {
    expect(appFormatters("en").date("not a date")).toBe("")
  })

  it("formats sizes with the language's unit", () => {
    expect(appFormatters("en").megabytes(5 * 1024 * 1024)).toBe("5.0 MB")
    expect(appFormatters("ar").megabytes(5 * 1024 * 1024)).toBe("5.0 ميغابايت")
  })

  it("picks the unit a size reads best in", () => {
    expect(appFormatters("en").bytes(512)).toBe("512 B")
    expect(appFormatters("en").bytes(1536)).toBe("1.5 KB")
    expect(appFormatters("en").bytes(50 * 1024 * 1024)).toBe("50 MB")
    expect(appFormatters("ar").bytes(3 * 1024 * 1024 * 1024)).toBe(
      "3.0 غيغابايت"
    )
  })

  it("formats decimals at a fixed number of places", () => {
    expect(appFormatters("en").decimal(3.456, 1)).toBe("3.5")
    expect(appFormatters("ar").decimal(3.456, 2)).toBe("3.46")
  })
})
