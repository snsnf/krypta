import { describe, expect, test } from "vitest"
import type { Question } from "@krypta/crypto"
import { encodeOtherAnswer } from "./form-other"
import { EMPTY_GRADES, setMark, type AnswerKey } from "./quiz"
import {
  automaticGrade,
  nextResponseToGrade,
  scoreResponse,
  summarizeQuiz,
} from "./quiz-score"

const choice: Question = {
  id: "q1",
  type: "multiple_choice",
  label: "Capital",
  options: ["Paris", "Lyon"],
}
const boxes: Question = {
  id: "q2",
  type: "checkboxes",
  label: "Primes",
  options: ["2", "3", "4"],
}
const text: Question = { id: "q3", type: "short_text", label: "River" }
const num: Question = { id: "q4", type: "number", label: "Sides" }
const essay: Question = { id: "q5", type: "long_text", label: "Why" }
const name: Question = { id: "q6", type: "short_text", label: "Name" }
const questions = [choice, boxes, text, num, essay, name]

const key: AnswerKey = {
  enabled: true,
  questions: {
    q1: { points: 1, correct: ["Paris"] },
    q2: { points: 2, correct: ["2", "3"] },
    q3: { points: 1, accepted: ["Seine", "the  Seine "] },
    q4: { points: 1, value: 3 },
    q5: { points: 5 },
    q6: { points: 0 },
  },
}

describe("automatic grading", () => {
  test("single choice matches exactly, and a written-in Other never does", () => {
    const entry = key.questions.q1
    expect(automaticGrade(choice, entry, "Paris")).toBe(true)
    expect(automaticGrade(choice, entry, "Lyon")).toBe(false)
    expect(automaticGrade(choice, entry, encodeOtherAnswer("Paris"))).toBe(false)
  })

  test("checkboxes need exactly the correct set", () => {
    const entry = key.questions.q2
    expect(automaticGrade(boxes, entry, ["3", "2"])).toBe(true)
    expect(automaticGrade(boxes, entry, ["2"])).toBe(false)
    expect(automaticGrade(boxes, entry, ["2", "3", "4"])).toBe(false)
    expect(
      automaticGrade(boxes, entry, ["2", "3", encodeOtherAnswer("5")])
    ).toBe(false)
  })

  test("short text ignores case and extra spaces", () => {
    const entry = key.questions.q3
    expect(automaticGrade(text, entry, "  seine ")).toBe(true)
    expect(automaticGrade(text, entry, "The Seine")).toBe(true)
    expect(automaticGrade(text, entry, "Loire")).toBe(false)
  })

  test("a number must match exactly", () => {
    const entry = key.questions.q4
    expect(automaticGrade(num, entry, "3")).toBe(true)
    expect(automaticGrade(num, entry, " 3.0 ")).toBe(true)
    expect(automaticGrade(num, entry, "4")).toBe(false)
    expect(automaticGrade(num, entry, "three")).toBe(false)
  })

  test("nothing to compare against means no automatic grade", () => {
    expect(automaticGrade(choice, { points: 1 }, "Paris")).toBeNull()
    expect(automaticGrade(text, { points: 1, accepted: [" "] }, "x")).toBeNull()
    expect(automaticGrade(essay, { points: 5 }, "Because")).toBeNull()
  })
})

const perfect = {
  q1: "Paris",
  q2: ["2", "3"],
  q3: "Seine",
  q4: "3",
  q5: "Because it is",
  q6: "Ana",
}

describe("scoring a response", () => {
  test("zero-point questions do not count and essays wait for a grade", () => {
    const score = scoreResponse(questions, key, perfect, undefined)
    expect(score.possible).toBe(10)
    expect(score.earned).toBe(5)
    expect(score.pending).toBe(1)
    expect(score.questions.q5.status).toBe("needs_grading")
    expect(score.questions.q6.status).toBe("not_scored")
  })

  test("a manual mark grades an essay and overrides an automatic result", () => {
    const score = scoreResponse(questions, key, { ...perfect, q1: "Lyon" }, {
      q5: true,
      q1: true,
    })
    expect(score.earned).toBe(10)
    expect(score.pending).toBe(0)
    expect(score.questions.q1.status).toBe("correct")
  })

  test("an unanswered question is simply wrong, essay included", () => {
    const score = scoreResponse(questions, key, {}, undefined)
    expect(score.earned).toBe(0)
    expect(score.pending).toBe(0)
    expect(score.questions.q5.status).toBe("incorrect")
  })

  test("marks for a deleted question are ignored", () => {
    const score = scoreResponse([choice], key, perfect, { gone: true })
    expect(score.possible).toBe(1)
    expect(score.earned).toBe(1)
  })
})

describe("summary and navigation", () => {
  const responses = [
    { id: "r1", answers: perfect },
    { id: "r2", answers: { ...perfect, q1: "Lyon" } },
    { id: "r3", answers: {} },
  ]

  test("averages only fully graded responses", () => {
    const grades = setMark(EMPTY_GRADES, "r1", "q5", true)
    const summary = summarizeQuiz(questions, key, responses, grades)
    expect(summary.possible).toBe(10)
    expect(summary.pending).toBe(1)
    expect(summary.graded).toBe(2)
    expect(summary.average).toBe(5)
    expect(summary.highest).toBe(10)
    expect(summary.lowest).toBe(0)
    expect(summary.histogram).toEqual([1, 0, 0, 0, 1])
    expect(summary.perQuestion.find((row) => row.questionId === "q1")).toEqual(
      { questionId: "q1", correct: 1, graded: 3 }
    )
    expect(summary.perQuestion.find((row) => row.questionId === "q5")).toEqual(
      { questionId: "q5", correct: 1, graded: 2 }
    )
  })

  test("next to grade skips the current response and wraps around", () => {
    expect(
      nextResponseToGrade(questions, key, responses, EMPTY_GRADES, "r2")
    ).toBe("r1")
    expect(
      nextResponseToGrade(questions, key, responses, EMPTY_GRADES, "r1")
    ).toBe("r2")
    const grades = setMark(
      setMark(EMPTY_GRADES, "r1", "q5", true),
      "r2",
      "q5",
      false
    )
    expect(nextResponseToGrade(questions, key, responses, grades, "r1")).toBeNull()
  })
})
