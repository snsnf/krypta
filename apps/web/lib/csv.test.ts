import { describe, expect, it } from "vitest"
import { csvCell, csvDocument } from "./csv"

describe("csvDocument", () => {
  it("starts with a byte-order mark so Excel reads Arabic as UTF-8", () => {
    const text = csvDocument(["الاسم"], ["أحمد"])
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.slice(1)).toBe("الاسم\nأحمد")
  })
})

describe("csvCell", () => {
  it("quotes every value, doubles quotes, and defuses formulas", () => {
    expect(csvCell("plain")).toBe('"plain"')
    expect(csvCell('a,"b"')).toBe('"a,""b"""')
    expect(csvCell("=SUM(A1)")).toBe(`"'=SUM(A1)"`)
  })
})
