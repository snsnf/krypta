import { describe, expect, test } from "vitest"
import { distinctOptions, hasDuplicateOptions } from "./question-options"

describe("question options", () => {
  test("keeps the first copy of each option text, in order", () => {
    expect(distinctOptions(["1", "2", "2", "3", "1"])).toEqual(["1", "2", "3"])
  })

  test("returns the same array when nothing repeats", () => {
    const options = ["Yes", "No"]
    expect(distinctOptions(options)).toBe(options)
  })

  test("a question with no options has none", () => {
    expect(distinctOptions(undefined)).toEqual([])
  })

  test("reports whether any text repeats", () => {
    expect(hasDuplicateOptions(["a", "b", "a"])).toBe(true)
    expect(hasDuplicateOptions(["a", "b"])).toBe(false)
    expect(hasDuplicateOptions(undefined)).toBe(false)
  })

  // Blank rows are options the creator has not typed yet, not choices that
  // collide, so two of them are not worth a warning.
  test("blank options do not count as duplicates", () => {
    expect(hasDuplicateOptions(["", "", "a"])).toBe(false)
  })
})
