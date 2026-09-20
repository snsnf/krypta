import type { Question } from "@krypta/crypto"

import { isFileAnswer, type AnswerValue } from "./form-answers"
import {
  isEmptyOtherAnswer,
  isOtherAnswer,
} from "./form-other"

const OTHER_ROW_LABEL = "Other"

export type QuestionSummary = {
  questionId: string
  label: string
  answered: number
  skipped: number
} & (
  | { kind: "choice"; options: { value: string; count: number }[] }
  | {
      kind: "number"
      // With zero parseable answers (answered === 0), these are all 0,
      // not undefined. Callers must check `answered` before trusting them.
      min: number
      max: number
      mean: number
      median: number
    }
  | {
      kind: "date"
      // With zero answered values, both are "", not undefined. Same rule
      // as `number` above: check `answered` before trusting these.
      earliest: string
      latest: string
    }
  | { kind: "text"; answers: string[] }
  | { kind: "file"; attached: number }
)

type SummaryKind = QuestionSummary["kind"]

function kindForQuestion(question: Question): SummaryKind {
  switch (question.type) {
    case "multiple_choice":
    case "dropdown":
    case "checkboxes":
      return "choice"
    case "number":
      return "number"
    case "date":
      return "date"
    case "file_upload":
      return "file"
    case "short_text":
    case "long_text":
    case "email":
    default:
      return "text"
  }
}

function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return isFileAnswer(value)
}

function summarizeChoice(
  question: Question,
  values: AnswerValue[]
): { options: { value: string; count: number }[] } {
  const counts = new Map<string, number>()
  for (const option of question.options ?? []) {
    counts.set(option, 0)
  }
  /*
   * Every written-in answer lands in one row. Counting them separately would
   * put a row on the chart per distinct phrase, so fifty free-text answers
   * would mean fifty rows and the real options would disappear among them.
   *
   * The label steps aside when the creator already has an option called
   * "Other", so a written-in answer is never merged with a chosen one.
   */
  const otherLabel = (question.options ?? []).includes(OTHER_ROW_LABEL)
    ? "Other (written in)"
    : OTHER_ROW_LABEL
  for (const value of values) {
    const selections = Array.isArray(value) ? value : [value as string]
    for (const selection of selections) {
      if (isEmptyOtherAnswer(selection)) continue
      const key = isOtherAnswer(selection) ? otherLabel : selection
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return {
    options: Array.from(counts.entries()).map(([value, count]) => ({
      value,
      count,
    })),
  }
}

function summarizeNumber(numbers: number[]): {
  min: number
  max: number
  mean: number
  median: number
} {
  numbers = [...numbers].sort((a, b) => a - b)

  if (numbers.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0 }
  }

  const min = numbers[0]
  const max = numbers[numbers.length - 1]
  const mean = numbers.reduce((sum, n) => sum + n, 0) / numbers.length
  const mid = Math.floor(numbers.length / 2)
  const median =
    numbers.length % 2 === 0
      ? (numbers[mid - 1] + numbers[mid]) / 2
      : numbers[mid]

  return { min, max, mean, median }
}

function summarizeDate(dates: string[]): {
  earliest: string
  latest: string
} {
  if (dates.length === 0) {
    return { earliest: "", latest: "" }
  }
  let earliest = dates[0]
  let latest = dates[0]
  for (const date of dates) {
    if (date < earliest) earliest = date
    if (date > latest) latest = date
  }
  return { earliest, latest }
}

function summarizeText(answers: string[]): { answers: string[] } {
  return { answers: answers.map((v) => v.trim()) }
}

/**
 * Question types are editable, and `changeQuestionType` (form-builder.tsx)
 * keeps the question's id when it changes its type, so an answer stored
 * under this id can be left over from whatever type the question used to
 * be. A `checkboxes` -> `short_text` edit leaves a `string[]` where a
 * `string` is expected; a `file_upload` -> `date`/`multiple_choice` edit
 * leaves a `FileAnswer` object. `summarizeDate` and `summarizeText` only
 * ever see strings, and `summarizeChoice` only ever sees strings or arrays
 * of strings: anything else is dropped here and counted as skipped, rather
 * than coerced with `String()`: a stringified object in a summary looks
 * like real data, and a dropped answer at least looks like nothing.
 */
function filterStrings(values: AnswerValue[]): {
  kept: string[]
  dropped: number
} {
  const kept: string[] = []
  let dropped = 0
  for (const value of values) {
    if (typeof value === "string") {
      kept.push(value)
    } else {
      dropped++
    }
  }
  return { kept, dropped }
}

function filterChoiceValues(values: AnswerValue[]): {
  kept: AnswerValue[]
  dropped: number
} {
  const kept: AnswerValue[] = []
  let dropped = 0
  for (const value of values) {
    if (typeof value === "string") {
      kept.push(value)
    } else if (Array.isArray(value)) {
      const strings = value.filter((v): v is string => typeof v === "string")
      if (strings.length > 0) {
        kept.push(strings)
      } else {
        dropped++
      }
    } else {
      dropped++
    }
  }
  return { kept, dropped }
}

export function summarizeResponses(
  questions: Question[],
  responses: Record<string, AnswerValue>[]
): QuestionSummary[] {
  return questions.map((question) => {
    const kind = kindForQuestion(question)
    const rawValues = responses.map((response) => response[question.id])
    const answeredValues: AnswerValue[] = []
    let skipped = 0
    for (const value of rawValues) {
      if (isAnswered(value)) {
        answeredValues.push(value as AnswerValue)
      } else {
        skipped++
      }
    }

    if (kind === "number") {
      // A present-but-unparseable value (e.g. "not a number") is present, so
      // it does not trip isAnswered's skip path, but it still cannot
      // contribute a statistic: treat it as skipped here instead.
      const numbers: number[] = []
      for (const value of answeredValues) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
          numbers.push(parsed)
        } else {
          skipped++
        }
      }
      const base = {
        questionId: question.id,
        label: question.label,
        answered: numbers.length,
        skipped,
      }
      return { ...base, kind, ...summarizeNumber(numbers) }
    }

    switch (kind) {
      case "choice": {
        const { kept, dropped } = filterChoiceValues(answeredValues)
        const base = {
          questionId: question.id,
          label: question.label,
          answered: kept.length,
          skipped: skipped + dropped,
        }
        return { ...base, kind, ...summarizeChoice(question, kept) }
      }
      case "date": {
        const { kept, dropped } = filterStrings(answeredValues)
        const base = {
          questionId: question.id,
          label: question.label,
          answered: kept.length,
          skipped: skipped + dropped,
        }
        return { ...base, kind, ...summarizeDate(kept) }
      }
      case "text": {
        const { kept, dropped } = filterStrings(answeredValues)
        const base = {
          questionId: question.id,
          label: question.label,
          answered: kept.length,
          skipped: skipped + dropped,
        }
        return { ...base, kind, ...summarizeText(kept) }
      }
      case "file": {
        const answered = answeredValues.length
        return {
          questionId: question.id,
          label: question.label,
          answered,
          skipped,
          kind,
          attached: answered,
        }
      }
    }
  })
}
