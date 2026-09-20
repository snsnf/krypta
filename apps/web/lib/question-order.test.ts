import { describe, expect, it } from "vitest"
import type { Question } from "@krypta/crypto"
import { duplicateQuestion, moveQuestion } from "./question-order"

function q(id: string, extra: Partial<Question> = {}): Question {
  return { id, type: "short_text", label: `label-${id}`, ...extra }
}

const ids = (questions: Question[]) => questions.map((x) => x.id)

describe("moveQuestion", () => {
  it("moves a question later", () => {
    const questions = [q("a"), q("b"), q("c")]
    expect(ids(moveQuestion(questions, "a", 2))).toEqual(["b", "c", "a"])
  })

  it("moves a question earlier", () => {
    const questions = [q("a"), q("b"), q("c")]
    expect(ids(moveQuestion(questions, "c", 0))).toEqual(["c", "a", "b"])
  })

  it("is a no-op past either end", () => {
    const questions = [q("a"), q("b")]
    expect(ids(moveQuestion(questions, "a", -1))).toEqual(["a", "b"])
    expect(ids(moveQuestion(questions, "b", 2))).toEqual(["a", "b"])
  })

  it("is a no-op for an unknown id", () => {
    const questions = [q("a"), q("b")]
    expect(ids(moveQuestion(questions, "missing", 0))).toEqual(["a", "b"])
  })

  it("does not mutate the input array", () => {
    const questions = [q("a"), q("b")]
    moveQuestion(questions, "a", 1)
    expect(ids(questions)).toEqual(["a", "b"])
  })

  it("can move a condition source below its dependent", () => {
    // The order that makes conditionSources exclude the source, which is what
    // drives the builder's dangling warning. Reordering must permit it: the
    // evaluator fails open and the builder warns.
    const questions = [
      q("source", { type: "multiple_choice", options: ["Yes", "No"] }),
      q("dependent", {
        condition: { questionId: "source", operator: "is", value: "Yes" },
      }),
    ]
    expect(ids(moveQuestion(questions, "source", 1))).toEqual([
      "dependent",
      "source",
    ])
  })
})

describe("duplicateQuestion", () => {
  it("inserts the copy immediately after the original", () => {
    const questions = [q("a"), q("b")]
    expect(ids(duplicateQuestion(questions, "a", "a2"))).toEqual(["a", "a2", "b"])
  })

  it("copies every field except the id", () => {
    const questions = [
      q("a", { type: "multiple_choice", options: ["Yes"], required: true }),
    ]
    const copy = duplicateQuestion(questions, "a", "a2")[1]
    expect(copy).toEqual({ ...questions[0], id: "a2" })
  })

  it("keeps the copy's condition, whose source is still earlier", () => {
    const questions = [
      q("source", { type: "multiple_choice", options: ["Yes"] }),
      q("dependent", {
        condition: { questionId: "source", operator: "is", value: "Yes" },
      }),
    ]
    const result = duplicateQuestion(questions, "dependent", "dependent2")
    expect(ids(result)).toEqual(["source", "dependent", "dependent2"])
    expect(result[2].condition).toEqual({
      questionId: "source",
      operator: "is",
      value: "Yes",
    })
  })

  it("is a no-op for an unknown id", () => {
    const questions = [q("a")]
    expect(ids(duplicateQuestion(questions, "missing", "x"))).toEqual(["a"])
  })
})
