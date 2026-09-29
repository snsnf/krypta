import { describe, expect, it } from "vitest"
import type { Question } from "@krypta/crypto"
import { conditionValues, visibleQuestions } from "./form-visibility"

function q(id: string, extra: Partial<Question> = {}): Question {
  return { id, type: "multiple_choice", label: id, options: ["Yes", "No"], ...extra }
}

const ids = (questions: Question[]) => questions.map((x) => x.id)

describe("visibleQuestions", () => {
  it("shows every question when none carries a condition", () => {
    const questions = [q("a"), q("b")]
    expect(ids(visibleQuestions(questions, {}))).toEqual(["a", "b"])
  })

  it("shows an `is` dependent only when the source matches", () => {
    const questions = [
      q("a"),
      q("b", { condition: { questionId: "a", operator: "is", value: "Yes" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "Yes" }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, { a: "No" }))).toEqual(["a"])
  })

  it("shows an `is_not` dependent only when the source does not match", () => {
    const questions = [
      q("a"),
      q("b", { condition: { questionId: "a", operator: "is_not", value: "Yes" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "No" }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, { a: "Yes" }))).toEqual(["a"])
  })

  it("matches a checkboxes answer by membership, not equality", () => {
    const questions = [
      q("a", { type: "checkboxes", options: ["Red", "Blue", "Green"] }),
      q("b", { condition: { questionId: "a", operator: "is", value: "Blue" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: ["Red", "Blue"] }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, { a: ["Red"] }))).toEqual(["a"])
  })

  it("hides transitively when the source question is itself hidden", () => {
    const questions = [
      q("a"),
      q("b", { condition: { questionId: "a", operator: "is", value: "Yes" } }),
      q("c", { condition: { questionId: "b", operator: "is", value: "Yes" } }),
    ]
    // b is hidden because a says No, so c is hidden too, even though the
    // answers map still carries b's stale "Yes" from before the branch flipped.
    expect(ids(visibleQuestions(questions, { a: "No", b: "Yes" }))).toEqual(["a"])
  })

  it("shows a question whose condition names a question that does not exist", () => {
    const questions = [
      q("a"),
      q("b", { condition: { questionId: "deleted", operator: "is", value: "Yes" } }),
    ]
    expect(ids(visibleQuestions(questions, {}))).toEqual(["a", "b"])
  })

  it("shows a question whose condition names a source that is no longer choice-like", () => {
    // The author switched the source to short_text after publishing. Matching
    // free text against an option string would hide the dependent from every
    // respondent, so an unusable source fails open just like a missing one.
    const questions = [
      q("a", { type: "short_text", options: undefined }),
      q("b", { condition: { questionId: "a", operator: "is", value: "Yes" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "anything" }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, {}))).toEqual(["a", "b"])
  })

  it("shows a question whose condition names a choice source with no options", () => {
    const questions = [
      q("a", { options: [] }),
      q("b", { condition: { questionId: "a", operator: "is", value: "Yes" } }),
    ]
    expect(ids(visibleQuestions(questions, {}))).toEqual(["a", "b"])
  })

  it("shows a question whose condition names a LATER question", () => {
    const questions = [
      q("a", { condition: { questionId: "b", operator: "is", value: "Yes" } }),
      q("b"),
    ]
    expect(ids(visibleQuestions(questions, { b: "Yes" }))).toEqual(["a", "b"])
  })

  it("treats an unanswered source asymmetrically: `is` hides, `is_not` shows", () => {
    const questions = [
      q("a"),
      q("b", { condition: { questionId: "a", operator: "is", value: "Yes" } }),
      q("c", { condition: { questionId: "a", operator: "is_not", value: "Yes" } }),
    ]
    // Deliberate: "not Yes" is true until contradicted.
    expect(ids(visibleQuestions(questions, {}))).toEqual(["a", "c"])
  })
  const stars = (id: string) =>
    q(id, {
      type: "rating",
      options: undefined,
      rating: { style: "stars", min: 1, max: 5 },
    })

  it("shows an `at_most` dependent at and below the bound only", () => {
    const questions = [
      stars("a"),
      q("b", { condition: { questionId: "a", operator: "at_most", value: "2" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "1" }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, { a: "2" }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, { a: "3" }))).toEqual(["a"])
  })

  it("shows an `at_least` dependent at and above the bound only", () => {
    const questions = [
      stars("a"),
      q("b", { condition: { questionId: "a", operator: "at_least", value: "4" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "4" }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, { a: "5" }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, { a: "3" }))).toEqual(["a"])
  })

  it("hides a range dependent until the rating is answered", () => {
    const questions = [
      stars("a"),
      q("b", { condition: { questionId: "a", operator: "at_most", value: "2" } }),
    ]
    expect(ids(visibleQuestions(questions, {}))).toEqual(["a"])
    expect(ids(visibleQuestions(questions, { a: "" }))).toEqual(["a"])
  })

  it("treats a stale out-of-range rating answer as unanswered", () => {
    const questions = [
      stars("a"),
      q("b", { condition: { questionId: "a", operator: "at_most", value: "2" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "0" }))).toEqual(["a"])
  })

  it("never matches a range bound outside the source's range", () => {
    const questions = [
      stars("a"),
      q("b", { condition: { questionId: "a", operator: "at_least", value: "8" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "5" }))).toEqual(["a"])
  })

  it("compares `is` against a rating as a string", () => {
    const questions = [
      stars("a"),
      q("b", { condition: { questionId: "a", operator: "is", value: "3" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "3" }))).toEqual(["a", "b"])
    expect(ids(visibleQuestions(questions, { a: "4" }))).toEqual(["a"])
  })

  it("fails open on a range operator whose source is a choice question", () => {
    const questions = [
      q("a"),
      q("b", { condition: { questionId: "a", operator: "at_most", value: "Yes" } }),
    ]
    expect(ids(visibleQuestions(questions, { a: "Yes" }))).toEqual(["a", "b"])
  })

  it("fails open on an operator this build does not know", () => {
    const questions = [
      q("a"),
      q("b", {
        condition: {
          questionId: "a",
          operator: "contains" as "is",
          value: "Yes",
        },
      }),
    ]
    expect(ids(visibleQuestions(questions, { a: "Yes" }))).toEqual(["a", "b"])
  })
})

describe("conditionValues", () => {
  it("lists a choice question's options and a rating's range", () => {
    expect(conditionValues(q("a"))).toEqual(["Yes", "No"])
    expect(
      conditionValues(
        q("r", {
          type: "rating",
          options: undefined,
          rating: { style: "scale", min: 0, max: 2 },
        })
      )
    ).toEqual(["0", "1", "2"])
  })

  it("returns null for anything that cannot be a source", () => {
    expect(conditionValues(undefined)).toBeNull()
    expect(
      conditionValues(q("t", { type: "short_text", options: undefined }))
    ).toBeNull()
    expect(conditionValues(q("e", { options: [] }))).toBeNull()
  })
})
