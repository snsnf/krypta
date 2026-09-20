import { describe, expect, it } from "vitest"

describe("form close date conversion", () => {
  it("round-trips a UTC instant through the local representation", async () => {
    const { localDateTimeToUtcIso, utcIsoToLocalDateTime } = await import(
      "./form-close-date"
    )
    const original = "2026-09-05T17:00:00.000Z"
    const local = utcIsoToLocalDateTime(original)
    const roundTripped = localDateTimeToUtcIso(local)
    expect(roundTripped).not.toBeNull()
    expect(new Date(roundTripped as string).getTime()).toBe(
      new Date(original).getTime()
    )
  })

  it("renders local time rather than a naive UTC string slice, when the environment has a non-zero offset", async () => {
    const { utcIsoToLocalDateTime } = await import("./form-close-date")
    const instant = "2026-09-05T17:00:00.000Z"
    const naiveSlice = instant.slice(0, 16)
    const offsetMinutes = new Date(instant).getTimezoneOffset()
    const local = utcIsoToLocalDateTime(instant)
    if (offsetMinutes === 0) {
      expect(local).toBe(naiveSlice)
    } else {
      expect(local).not.toBe(naiveSlice)
    }
  })

  it("maps an empty local input to null, and a null instant to an empty local input", async () => {
    const { localDateTimeToUtcIso, utcIsoToLocalDateTime } = await import(
      "./form-close-date"
    )
    expect(localDateTimeToUtcIso("")).toBeNull()
    expect(utcIsoToLocalDateTime(null)).toBe("")
  })

  it("treats an unparseable input as absent rather than throwing or producing 'Invalid Date'", async () => {
    const { localDateTimeToUtcIso, utcIsoToLocalDateTime } = await import(
      "./form-close-date"
    )
    expect(localDateTimeToUtcIso("not a date")).toBeNull()
    expect(utcIsoToLocalDateTime("not a date")).toBe("")
  })

  it("preserves a non-zero minute component across the round trip", async () => {
    const { localDateTimeToUtcIso, utcIsoToLocalDateTime } = await import(
      "./form-close-date"
    )
    const original = "2026-09-05T17:45:00.000Z"
    const local = utcIsoToLocalDateTime(original)
    expect(local.slice(-2)).not.toBe("00")
    const roundTripped = localDateTimeToUtcIso(local)
    expect(new Date(roundTripped as string).getMinutes()).toBe(
      new Date(original).getMinutes()
    )
  })
})
