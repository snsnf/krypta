import { describe, expect, it } from "vitest"
import type { Question } from "@krypta/crypto"
import { visibleQuestions } from "./form-visibility"

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
})
