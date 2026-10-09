import { describe, expect, test } from "vitest"
import type { Question } from "@krypta/crypto"
import {
  EMPTY_GRADES,
  parseAnswerKey,
  parseGrades,
  reconcileAnswerKey,
  removeResponseMarks,
  renameOptionInKey,
  setMark,
  type AnswerKey,
} from "./quiz"

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

const key: AnswerKey = {
  enabled: true,
  questions: {
    q1: { points: 1, correct: ["Paris"] },
    q2: { points: 2, correct: ["2", "3"] },
    q3: { points: 1, accepted: ["Seine"] },
    q4: { points: 1, value: 3 },
  },
}

describe("answer key validation", () => {
  test("accepts a well-formed key", () => {
    expect(parseAnswerKey(JSON.parse(JSON.stringify(key)))).toEqual(key)
  })

  test("refuses anything that is not exactly the shape", () => {
    const bad = [
      null,
      [],
      { enabled: true },
      { enabled: "yes", questions: {} },
      { enabled: true, questions: { q1: null } },
      { enabled: true, questions: { q1: { points: -1 } } },
      { enabled: true, questions: { q1: { points: 1.5 } } },
      { enabled: true, questions: { q1: { points: 101 } } },
      { enabled: true, questions: { q1: { points: 1, correct: "Paris" } } },
      { enabled: true, questions: { q1: { points: 1, correct: [1] } } },
      { enabled: true, questions: { q1: { points: 1, accepted: "x" } } },
      { enabled: true, questions: { q1: { points: 1, value: "4" } } },
      { enabled: true, questions: { q1: { points: 1, value: Infinity } } },
    ]
    for (const value of bad) expect(parseAnswerKey(value)).toBeNull()
  })

  test("a question id cannot reach the prototype", () => {
    const parsed = parseAnswerKey(
      JSON.parse('{"enabled":true,"questions":{"__proto__":{"points":1}}}')
    )
    expect(parsed).not.toBeNull()
    expect(Object.getPrototypeOf(parsed!.questions)).toBe(Object.prototype)
    expect(Object.keys(parsed!.questions)).toEqual(["__proto__"])
  })
})

describe("grades validation", () => {
  test("accepts well-formed grades", () => {
    const grades = { responses: { r1: { q1: true, q2: false } } }
    expect(parseGrades(JSON.parse(JSON.stringify(grades)))).toEqual(grades)
  })

  test("refuses anything that is not exactly the shape", () => {
    const bad = [
      null,
      {},
      { responses: [] },
      { responses: { r1: null } },
      { responses: { r1: { q1: "yes" } } },
    ]
    for (const value of bad) expect(parseGrades(value)).toBeNull()
  })
})

describe("reconciling the key with the questions", () => {
  test("returns the same object when nothing is stale", () => {
    expect(reconcileAnswerKey([choice, boxes, text, num], key)).toBe(key)
  })

  test("drops the entry of a deleted question", () => {
    const next = reconcileAnswerKey([choice, boxes, text], key)
    expect(next.questions.q4).toBeUndefined()
    expect(next.questions.q1).toBe(key.questions.q1)
  })

  test("drops a correct option the question no longer lists", () => {
    const next = reconcileAnswerKey(
      [choice, { ...boxes, options: ["2", "4"] }, text, num],
      key
    )
    expect(next.questions.q2).toEqual({ points: 2, correct: ["2"] })
  })

  test("a type change clears the answer and keeps the points", () => {
    const next = reconcileAnswerKey(
      [{ ...choice, type: "long_text" }, boxes, text, num],
      key
    )
    expect(next.questions.q1).toEqual({ points: 1 })
  })

  test("a single-choice question cannot keep two correct options", () => {
    const next = reconcileAnswerKey(
      [choice, { ...boxes, type: "multiple_choice" }, text, num],
      key
    )
    expect(next.questions.q2).toEqual({ points: 2 })
  })

  test("accepted answers belong to short text and a value to number", () => {
    const next = reconcileAnswerKey(
      [
        choice,
        boxes,
        { ...text, type: "number" },
        { ...num, type: "short_text" },
      ],
      key
    )
    expect(next.questions.q3).toEqual({ points: 1 })
    expect(next.questions.q4).toEqual({ points: 1 })
  })
})

describe("renaming an option", () => {
  test("the correct answer follows the rename", () => {
    const next = renameOptionInKey(key, "q1", "Paris", "Paris, France")
    expect(next.questions.q1.correct).toEqual(["Paris, France"])
  })

  test("an unrelated rename changes nothing", () => {
    expect(renameOptionInKey(key, "q1", "Lyon", "Marseille")).toBe(key)
    expect(renameOptionInKey(key, "missing", "a", "b")).toBe(key)
  })
})

describe("marks", () => {
  test("setting and clearing a mark", () => {
    const marked = setMark(EMPTY_GRADES, "r1", "q1", true)
    expect(marked.responses).toEqual({ r1: { q1: true } })
    expect(setMark(marked, "r1", "q1", true)).toBe(marked)
    const cleared = setMark(marked, "r1", "q1", null)
    expect(cleared.responses).toEqual({})
    expect(setMark(cleared, "r1", "q1", null)).toBe(cleared)
  })

  test("removing a response's marks", () => {
    const marked = setMark(EMPTY_GRADES, "r1", "q1", false)
    expect(removeResponseMarks(marked, ["r1"]).responses).toEqual({})
    expect(removeResponseMarks(marked, ["r2"])).toBe(marked)
  })

  test("removing several responses' marks at once", () => {
    const marked = setMark(
      setMark(setMark(EMPTY_GRADES, "r1", "q1", true), "r2", "q1", false),
      "r3",
      "q1",
      true
    )
    expect(removeResponseMarks(marked, ["r1", "r3", "r9"]).responses).toEqual({
      r2: { q1: false },
    })
  })
})
