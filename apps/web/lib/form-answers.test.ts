import { describe, expect, it, test } from "vitest"
import type { Question } from "@krypta/crypto"
import { encodeOtherAnswer } from "./form-other"
import {
  firstUnansweredIndex,
  formatAnswer,
  isAnswerEmpty,
  reconcileDraft,
} from "./form-answers"

function q(id: string): Question {
  return { id, type: "short_text", label: id }
}

describe("isAnswerEmpty", () => {
  test("treats undefined, an empty string and an empty list as empty", () => {
    expect(isAnswerEmpty(undefined)).toBe(true)
    expect(isAnswerEmpty("")).toBe(true)
    expect(isAnswerEmpty([])).toBe(true)
  })

  test("treats written text and a chosen option as answered", () => {
    expect(isAnswerEmpty("hello")).toBe(false)
    expect(isAnswerEmpty(["a"])).toBe(false)
  })

  test("an Other selection with nothing written in it is still empty", () => {
    expect(isAnswerEmpty(encodeOtherAnswer(""))).toBe(true)
    expect(isAnswerEmpty([encodeOtherAnswer("")])).toBe(true)
    expect(isAnswerEmpty(encodeOtherAnswer("something"))).toBe(false)
  })

  test("an uploaded file is an answer", () => {
    expect(
      isAnswerEmpty({
        attachmentId: "a",
        filename: "f.pdf",
        mimeType: "application/pdf",
        size: 1,
      })
    ).toBe(false)
  })
})

describe("firstUnansweredIndex", () => {
  const questions = [q("a"), q("b"), q("c")]

  test("with no answers at all, starts at the beginning as before", () => {
    expect(firstUnansweredIndex(questions, {})).toBe(0)
  })

  test("skips past the answers a restored draft already holds", () => {
    expect(firstUnansweredIndex(questions, { a: "one" })).toBe(1)
    expect(firstUnansweredIndex(questions, { a: "one", b: "two" })).toBe(2)
  })

  test("stops at the first gap rather than the last answer", () => {
    expect(firstUnansweredIndex(questions, { a: "one", c: "three" })).toBe(1)
  })

  test("a fully answered form lands on the last question, which carries submit", () => {
    expect(
      firstUnansweredIndex(questions, { a: "one", b: "two", c: "three" })
    ).toBe(2)
  })

  test("an answer that is only a blank Other does not count as progress", () => {
    expect(firstUnansweredIndex(questions, { a: encodeOtherAnswer("") })).toBe(0)
  })

  test("an empty question list is index 0, never -1", () => {
    expect(firstUnansweredIndex([], { a: "one" })).toBe(0)
  })

  test("answers for questions no longer on the form are ignored", () => {
    expect(firstUnansweredIndex(questions, { deleted: "stale" })).toBe(0)
  })
})


describe("reconcileDraft", () => {
  test("keeps an in-range rating and drops a stale or malformed one", () => {
    const rating: Question = {
      id: "r",
      type: "rating",
      label: "r",
      rating: { style: "stars", min: 1, max: 5 },
    }
    expect(reconcileDraft([rating], { r: "4" })).toEqual({ r: "4" })
    expect(reconcileDraft([rating], { r: "9" })).toEqual({})
    expect(reconcileDraft([rating], { r: "2.5" })).toEqual({})
    expect(reconcileDraft([rating], { r: ["4"] })).toEqual({})
  })

  const file = {
    attachmentId: "a",
    filename: "f.pdf",
    mimeType: "application/pdf",
    size: 1,
  }

  function choice(id: string, options: string[], extra: Partial<Question> = {}) {
    return {
      id,
      type: "multiple_choice",
      label: id,
      options,
      ...extra,
    } as Question
  }

  test("drops an answer the question can no longer hold, which is the bug", () => {
    // Typed as free text on day one, changed to multiple choice on day two.
    // The string restores, counts as answered, and matches no option, so the
    // respondent sees a blank question nothing asks them to fill in.
    const questions = [choice("q3", ["Daily", "Weekly", "Monthly"])]
    expect(reconcileDraft(questions, { q3: "roughly weekly" })).toEqual({})
  })

  test("keeps a choice that is still on offer", () => {
    const questions = [choice("q3", ["Daily", "Weekly"])]
    expect(reconcileDraft(questions, { q3: "Weekly" })).toEqual({
      q3: "Weekly",
    })
  })

  test("returns the same object when nothing was dropped, so a clean restore costs nothing", () => {
    const questions = [q("a"), q("b")]
    const answers = { a: "one", b: "two" }
    expect(reconcileDraft(questions, answers)).toBe(answers)
  })

  test("running it twice changes nothing the first pass did not", () => {
    const questions = [choice("q3", ["Daily"])]
    const once = reconcileDraft(questions, { q3: "stale", other: "gone" })
    expect(reconcileDraft(questions, once)).toBe(once)
  })

  test("drops an answer whose question was deleted", () => {
    expect(reconcileDraft([q("a")], { a: "keep", removed: "drop" })).toEqual({
      a: "keep",
    })
  })

  test("keeps an answer to a question hidden by a condition", () => {
    // Matched against every question rather than the visible ones. Toggling a
    // branch back and forth must not destroy the work behind it.
    const hidden: Question = {
      id: "b",
      type: "short_text",
      label: "b",
      condition: { questionId: "a", operator: "is", value: "yes" },
    }
    const answers = { a: "no", b: "written earlier" }
    expect(reconcileDraft([q("a"), hidden], answers)).toBe(answers)
  })

  test("drops a value whose shape the question cannot hold", () => {
    expect(reconcileDraft([q("a")], { a: ["one"] })).toEqual({})
    expect(reconcileDraft([q("a")], { a: file })).toEqual({})
    const checkboxes = choice("c", ["x"], { type: "checkboxes" })
    expect(reconcileDraft([checkboxes], { c: "x" })).toEqual({})
  })

  test("keeps the ticked boxes still on offer and drops the rest", () => {
    const checkboxes = choice("c", ["x", "y"], { type: "checkboxes" })
    expect(reconcileDraft([checkboxes], { c: ["x", "gone"] })).toEqual({
      c: ["x"],
    })
    expect(reconcileDraft([checkboxes], { c: ["gone"] })).toEqual({})
  })

  test("a written-in Other survives only where Other is still offered", () => {
    const withOther = choice("q", ["a"], { allowOther: true })
    const withoutOther = choice("q", ["a"])
    const written = encodeOtherAnswer("something else")
    expect(reconcileDraft([withOther], { q: written })).toEqual({ q: written })
    expect(reconcileDraft([withoutOther], { q: written })).toEqual({})
  })

  test("a written-in Other cannot survive on a type that never offers one", () => {
    const dropdown = choice("q", ["a"], { type: "dropdown", allowOther: true })
    expect(reconcileDraft([dropdown], { q: encodeOtherAnswer("x") })).toEqual({})
    expect(reconcileDraft([q("a")], { a: encodeOtherAnswer("x") })).toEqual({})
  })

  test("does not judge the contents of a text-shaped answer", () => {
    // A wrong-looking value lands in a field the respondent can see and fix,
    // and submit still stops it. Dropping it would delete recoverable work.
    const questions = [
      { id: "n", type: "number", label: "n" } as Question,
      { id: "e", type: "email", label: "e" } as Question,
      { id: "d", type: "date", label: "d" } as Question,
    ]
    const answers = { n: "twelve", e: "bob at example", d: "someday" }
    expect(reconcileDraft(questions, answers)).toBe(answers)
  })

  test("keeps an answer to a question type this build does not know", () => {
    const future = { id: "f", type: "signature", label: "f" } as unknown as Question
    const answers = { f: "scribble" }
    expect(reconcileDraft([future], answers)).toBe(answers)
  })

  test("keeps an uploaded file on the question that asked for one", () => {
    const upload = { id: "u", type: "file_upload", label: "u" } as Question
    expect(reconcileDraft([upload], { u: file })).toEqual({ u: file })
    expect(reconcileDraft([upload], { u: "not a file" })).toEqual({})
  })

  test("is subtractive: it never introduces an answer the respondent did not give", () => {
    // This is what keeps it clear of the sealing path. The payload built at
    // submit can only ever shrink.
    const questions = [q("a"), choice("b", ["x"]), q("c")]
    const result = reconcileDraft(questions, { a: "one", b: "stale" })
    expect(Object.keys(result)).toEqual(["a"])
  })
})

describe("formatAnswer", () => {
  it("shows nothing for an unanswered question", () => {
    expect(formatAnswer(undefined)).toBe("")
  })

  it("shows an ordinary answer as it is", () => {
    expect(formatAnswer("Blue")).toBe("Blue")
  })

  it("shows a written-in answer as its text, never the marker", () => {
    const cell = formatAnswer(encodeOtherAnswer("Bicycle"))
    expect(cell).toBe("Bicycle")
    expect(cell).not.toContain("\u0000")
  })

  it("names an Other answer left blank rather than showing it empty", () => {
    expect(formatAnswer(encodeOtherAnswer("  "))).toBe("Other")
  })

  it("joins checkbox selections, decoding a written-in one", () => {
    expect(formatAnswer(["Red", encodeOtherAnswer("Teal")])).toBe("Red, Teal")
  })

  it("shows a file by its name", () => {
    expect(
      formatAnswer({
        attachmentId: "a",
        filename: "cv.pdf",
        mimeType: "application/pdf",
        size: 1,
      })
    ).toBe("cv.pdf")
  })
})
