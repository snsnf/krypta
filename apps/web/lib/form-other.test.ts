import { describe, expect, it } from "vitest"
import {
  decodeOtherAnswer,
  displayAnswer,
  encodeOtherAnswer,
  isEmptyOtherAnswer,
  isOtherAnswer,
} from "./form-other"

describe("form-other", () => {
  it("round-trips the written text", () => {
    expect(decodeOtherAnswer(encodeOtherAnswer("Bicycle"))).toBe("Bicycle")
  })

  it("leaves an ordinary option alone", () => {
    expect(isOtherAnswer("Bicycle")).toBe(false)
    expect(decodeOtherAnswer("Bicycle")).toBeNull()
    expect(displayAnswer("Bicycle")).toBe("Bicycle")
  })

  /*
   * The whole design rests on this: a creator can legitimately write an option
   * called "Other", and it must stay an ordinary option. Only the U+0000
   * prefix marks a respondent's own text.
   */
  it("does not mistake an option that merely mentions other for the marker", () => {
    for (const option of ["Other", "other:Bicycle", "other", "Any other"]) {
      expect(isOtherAnswer(option)).toBe(false)
      expect(displayAnswer(option)).toBe(option)
    }
  })

  it("shows what the person wrote rather than the marker", () => {
    expect(displayAnswer(encodeOtherAnswer("Bicycle"))).toBe("Bicycle")
  })

  it("names an Other answer left blank instead of rendering nothing", () => {
    expect(displayAnswer(encodeOtherAnswer(""))).toBe("Other")
  })

  it("treats Other with no text as unanswered, so required still bites", () => {
    expect(isEmptyOtherAnswer(encodeOtherAnswer(""))).toBe(true)
    expect(isEmptyOtherAnswer(encodeOtherAnswer("   "))).toBe(true)
    expect(isEmptyOtherAnswer(encodeOtherAnswer("Bicycle"))).toBe(false)
    expect(isEmptyOtherAnswer("Bicycle")).toBe(false)
  })

  it("keeps text that contains a colon or spaces intact", () => {
    const text = "bike: the folding kind"
    expect(decodeOtherAnswer(encodeOtherAnswer(text))).toBe(text)
  })
})
