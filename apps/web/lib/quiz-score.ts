import type { Question } from "@krypta/crypto"
import { isAnswerEmpty, type AnswerValue } from "./form-answers"
import { isOtherAnswer } from "./form-other"
import {
  entryFor,
  marksFor,
  type AnswerKey,
  type AnswerKeyEntry,
  type Grades,
} from "./quiz"

/**
 * Scoring runs here, in the member's browser, on answers it has already
 * decrypted. It cannot run anywhere else: the server holds neither the
 * answers nor the key, and a respondent's browser must not hold the key.
 * Scores are therefore never stored; they are recomputed on every view, which
 * is also why fixing a wrong answer key regrades every response at once.
 */

export type QuestionScoreStatus =
  | "correct"
  | "incorrect"
  | "needs_grading"
  | "not_scored"

export interface QuestionScore {
  status: QuestionScoreStatus
  points: number
  earned: number
}

export interface ResponseScore {
  earned: number
  possible: number
  /** How many scored questions still wait for a manual grade. */
  pending: number
  questions: Record<string, QuestionScore>
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * Whether an answer is right by the key alone, or null when the key cannot
 * say: a type graded by hand, or a question with no correct answer set.
 */
export function automaticGrade(
  question: Question,
  entry: AnswerKeyEntry,
  answer: AnswerValue | undefined
): boolean | null {
  switch (question.type) {
    case "multiple_choice":
    case "dropdown": {
      const correct = entry.correct?.[0]
      if (correct === undefined) return null
      if (isAnswerEmpty(answer) || typeof answer !== "string") return false
      // A written-in Other answer is the respondent's own text, never one of
      // the creator's options, even when it happens to spell one.
      return !isOtherAnswer(answer) && answer === correct
    }
    case "checkboxes": {
      const correct = entry.correct
      if (correct === undefined || correct.length === 0) return null
      if (isAnswerEmpty(answer) || !Array.isArray(answer)) return false
      const chosen = new Set(answer)
      return (
        chosen.size === correct.length &&
        correct.every((option) => chosen.has(option))
      )
    }
    case "short_text": {
      const accepted = (entry.accepted ?? [])
        .map(normalizeText)
        .filter((candidate) => candidate !== "")
      if (accepted.length === 0) return null
      if (isAnswerEmpty(answer) || typeof answer !== "string") return false
      return accepted.includes(normalizeText(answer))
    }
    case "number": {
      if (entry.value === undefined) return null
      if (isAnswerEmpty(answer) || typeof answer !== "string") return false
      const given = Number(answer.trim())
      return Number.isFinite(given) && given === entry.value
    }
    default:
      return null
  }
}

/**
 * One response's score. A manual mark always wins; otherwise the automatic
 * grade; otherwise an unanswered question is wrong, and anything left waits
 * for a person.
 */
export function scoreResponse(
  questions: Question[],
  key: AnswerKey,
  answers: Record<string, AnswerValue>,
  marks: Record<string, boolean> | undefined
): ResponseScore {
  let earned = 0
  let possible = 0
  let pending = 0
  const scores: Record<string, QuestionScore> = {}
  for (const question of questions) {
    const entry = entryFor(key, question.id)
    if (entry === undefined || entry.points === 0) {
      scores[question.id] = { status: "not_scored", points: 0, earned: 0 }
      continue
    }
    const points = entry.points
    possible += points
    const answer = answers[question.id]
    const mark =
      marks !== undefined && Object.hasOwn(marks, question.id)
        ? marks[question.id]
        : undefined
    const result =
      mark ??
      automaticGrade(question, entry, answer) ??
      (isAnswerEmpty(answer) ? false : null)
    if (result === null) {
      pending += 1
      scores[question.id] = { status: "needs_grading", points, earned: 0 }
      continue
    }
    const gained = result ? points : 0
    earned += gained
    scores[question.id] = {
      status: result ? "correct" : "incorrect",
      points,
      earned: gained,
    }
  }
  return { earned, possible, pending, questions: scores }
}

export const SCORE_BUCKETS = 5

export interface QuizSummaryData {
  possible: number
  /** Fully graded responses, the only ones the figures below describe. */
  graded: number
  /** Responses with at least one question still waiting for a grade. */
  pending: number
  average: number | null
  highest: number | null
  lowest: number | null
  /** Fully graded responses per fifth of the possible score, lowest first. */
  histogram: number[]
  /** Per scored question: correct out of the responses where it has a grade. */
  perQuestion: { questionId: string; correct: number; graded: number }[]
}

export function summarizeQuiz(
  questions: Question[],
  key: AnswerKey,
  responses: { id: string; answers: Record<string, AnswerValue> }[],
  grades: Grades
): QuizSummaryData {
  const scored = questions.filter(
    (question) => (entryFor(key, question.id)?.points ?? 0) > 0
  )
  const possible = scored.reduce(
    (total, question) => total + (entryFor(key, question.id)?.points ?? 0),
    0
  )
  const perQuestion = scored.map((question) => ({
    questionId: question.id,
    correct: 0,
    graded: 0,
  }))
  const histogram = new Array<number>(SCORE_BUCKETS).fill(0)
  const totals: number[] = []
  let pending = 0

  for (const response of responses) {
    const score = scoreResponse(
      questions,
      key,
      response.answers,
      marksFor(grades, response.id)
    )
    for (const row of perQuestion) {
      const status = score.questions[row.questionId].status
      if (status === "correct" || status === "incorrect") {
        row.graded += 1
        if (status === "correct") row.correct += 1
      }
    }
    // A half-graded response would drag every figure down, so it is counted
    // as waiting rather than averaged in.
    if (score.pending > 0) {
      pending += 1
      continue
    }
    totals.push(score.earned)
    if (possible > 0) {
      const bucket = Math.floor((score.earned / possible) * SCORE_BUCKETS)
      histogram[Math.min(SCORE_BUCKETS - 1, bucket)] += 1
    }
  }

  // reduce rather than Math.max(...totals): spreading a large form's
  // responses into arguments can exceed the engine's call stack.
  const sum = totals.reduce((total, earned) => total + earned, 0)
  return {
    possible,
    graded: totals.length,
    pending,
    average:
      totals.length === 0 ? null : Math.round((sum / totals.length) * 10) / 10,
    highest:
      totals.length === 0
        ? null
        : totals.reduce((best, earned) => Math.max(best, earned)),
    lowest:
      totals.length === 0
        ? null
        : totals.reduce((worst, earned) => Math.min(worst, earned)),
    histogram,
    perQuestion,
  }
}

/**
 * The next response after `currentId`, in the order given, that still has a
 * question waiting for a grade, wrapping around to the start. Null when no
 * other response is waiting.
 */
export function nextResponseToGrade(
  questions: Question[],
  key: AnswerKey,
  responses: { id: string; answers: Record<string, AnswerValue> }[],
  grades: Grades,
  currentId: string
): string | null {
  const start = responses.findIndex((response) => response.id === currentId)
  const offset = start === -1 ? 0 : start + 1
  for (let step = 0; step < responses.length; step++) {
    const candidate = responses[(offset + step) % responses.length]
    if (candidate.id === currentId) continue
    const score = scoreResponse(
      questions,
      key,
      candidate.answers,
      marksFor(grades, candidate.id)
    )
    if (score.pending > 0) return candidate.id
  }
  return null
}
