import type { Question } from "@krypta/crypto"

/**
 * The shapes a quiz is stored as, and the pure operations on them.
 *
 * Both shapes are JSON encrypted under the quiz key (`lib/quiz-sealing.ts`),
 * which only members hold. Neither is ever read by the server or sent to a
 * respondent. Correct answers are stored as option text because options have
 * no ids, which is why renaming an option has to carry the key with it
 * (`renameOptionInKey`) and deleting one has to drop it (`reconcileAnswerKey`).
 */

export const MAX_QUIZ_POINTS = 100

export interface AnswerKeyEntry {
  points: number
  /** Multiple choice and dropdown: exactly one. Checkboxes: one or more. */
  correct?: string[]
  /** Short text: matched ignoring case and extra spaces. */
  accepted?: string[]
  /** Number: matched exactly. */
  value?: number
}

export interface AnswerKey {
  /** Off keeps the key, so switching quiz mode back on loses nothing. */
  enabled: boolean
  questions: Record<string, AnswerKeyEntry>
}

/** Manual marks, by response id and then question id. */
export interface Grades {
  responses: Record<string, Record<string, boolean>>
}

export const EMPTY_GRADES: Grades = { responses: {} }

const SINGLE_CHOICE_TYPES = new Set<Question["type"]>([
  "multiple_choice",
  "dropdown",
])

export function isChoiceType(type: Question["type"]): boolean {
  return SINGLE_CHOICE_TYPES.has(type) || type === "checkboxes"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  )
}

function parseEntry(value: unknown): AnswerKeyEntry | null {
  if (!isRecord(value)) return null
  const { points, correct, accepted, value: exact } = value
  if (
    typeof points !== "number" ||
    !Number.isInteger(points) ||
    points < 0 ||
    points > MAX_QUIZ_POINTS
  ) {
    return null
  }
  const entry: AnswerKeyEntry = { points }
  if (correct !== undefined) {
    if (!isStringArray(correct)) return null
    entry.correct = [...correct]
  }
  if (accepted !== undefined) {
    if (!isStringArray(accepted)) return null
    entry.accepted = [...accepted]
  }
  if (exact !== undefined) {
    if (typeof exact !== "number" || !Number.isFinite(exact)) return null
    entry.value = exact
  }
  return entry
}

/**
 * A decrypted answer key, or null for anything that is not exactly this
 * shape. Refused whole rather than read in part: a half-read key would score
 * responses against answers nobody set.
 *
 * Built with `Object.fromEntries` so an id such as `__proto__` becomes an
 * ordinary key rather than a prototype assignment.
 */
export function parseAnswerKey(value: unknown): AnswerKey | null {
  if (
    !isRecord(value) ||
    typeof value.enabled !== "boolean" ||
    !isRecord(value.questions)
  ) {
    return null
  }
  const entries: [string, AnswerKeyEntry][] = []
  for (const [id, raw] of Object.entries(value.questions)) {
    const entry = parseEntry(raw)
    if (entry === null) return null
    entries.push([id, entry])
  }
  return { enabled: value.enabled, questions: Object.fromEntries(entries) }
}

/** Decrypted grades, or null for anything that is not exactly this shape. */
export function parseGrades(value: unknown): Grades | null {
  if (!isRecord(value) || !isRecord(value.responses)) return null
  const responses: [string, Record<string, boolean>][] = []
  for (const [responseId, rawMarks] of Object.entries(value.responses)) {
    if (!isRecord(rawMarks)) return null
    const marks: [string, boolean][] = []
    for (const [questionId, mark] of Object.entries(rawMarks)) {
      if (typeof mark !== "boolean") return null
      marks.push([questionId, mark])
    }
    responses.push([responseId, Object.fromEntries(marks)])
  }
  return { responses: Object.fromEntries(responses) }
}

export function entryFor(
  key: AnswerKey,
  questionId: string
): AnswerKeyEntry | undefined {
  return Object.hasOwn(key.questions, questionId)
    ? key.questions[questionId]
    : undefined
}

export function marksFor(
  grades: Grades,
  responseId: string
): Record<string, boolean> | undefined {
  return Object.hasOwn(grades.responses, responseId)
    ? grades.responses[responseId]
    : undefined
}

function reconcileEntry(
  question: Question,
  entry: AnswerKeyEntry
): AnswerKeyEntry {
  const next: AnswerKeyEntry = { points: entry.points }
  let changed = false
  if (entry.correct !== undefined) {
    const options = new Set(question.options ?? [])
    const kept = isChoiceType(question.type)
      ? entry.correct.filter((option) => options.has(option))
      : []
    const tooMany = SINGLE_CHOICE_TYPES.has(question.type) && kept.length > 1
    if (kept.length > 0 && !tooMany) {
      next.correct = kept
      if (kept.length !== entry.correct.length) changed = true
    } else {
      changed = true
    }
  }
  if (entry.accepted !== undefined) {
    if (question.type === "short_text") next.accepted = entry.accepted
    else changed = true
  }
  if (entry.value !== undefined) {
    if (question.type === "number") next.value = entry.value
    else changed = true
  }
  return changed ? next : entry
}

/**
 * Drops whatever the key says about questions and options that no longer
 * exist, run just before the key is saved.
 *
 * Subtractive only: it removes an entry, a correct option, or an answer that no
 * longer fits the question's type, and never invents one. It keeps points when
 * it clears an answer, since a question changing type is still worth what the
 * creator said. Returns the same object when it drops nothing.
 */
export function reconcileAnswerKey(
  questions: Question[],
  key: AnswerKey
): AnswerKey {
  const byId = new Map(questions.map((question) => [question.id, question]))
  let changed = false
  const entries: [string, AnswerKeyEntry][] = []
  for (const [id, entry] of Object.entries(key.questions)) {
    const question = byId.get(id)
    if (question === undefined) {
      changed = true
      continue
    }
    const next = reconcileEntry(question, entry)
    if (next !== entry) changed = true
    entries.push([id, next])
  }
  return changed ? { ...key, questions: Object.fromEntries(entries) } : key
}

/** Carries a correct answer along when the creator renames its option. */
export function renameOptionInKey(
  key: AnswerKey,
  questionId: string,
  from: string,
  to: string
): AnswerKey {
  const entry = entryFor(key, questionId)
  if (from === to || entry?.correct === undefined) return key
  if (!entry.correct.includes(from)) return key
  return {
    ...key,
    questions: {
      ...key.questions,
      [questionId]: {
        ...entry,
        correct: entry.correct.map((option) => (option === from ? to : option)),
      },
    },
  }
}

/** Sets a manual mark, or clears it with `null`. Same object if unchanged. */
export function setMark(
  grades: Grades,
  responseId: string,
  questionId: string,
  mark: boolean | null
): Grades {
  const marks = marksFor(grades, responseId)
  const current =
    marks !== undefined && Object.hasOwn(marks, questionId)
      ? marks[questionId]
      : undefined
  if (mark === null ? current === undefined : current === mark) return grades

  const nextMarks = { ...marks }
  if (mark === null) delete nextMarks[questionId]
  else nextMarks[questionId] = mark
  const responses = { ...grades.responses }
  if (Object.keys(nextMarks).length === 0) delete responses[responseId]
  else responses[responseId] = nextMarks
  return { responses }
}

/** Forgets deleted responses' marks. Same object if none of them had any. */
export function removeResponseMarks(
  grades: Grades,
  responseIds: readonly string[]
): Grades {
  const marked = responseIds.filter((id) => Object.hasOwn(grades.responses, id))
  if (marked.length === 0) return grades
  const responses = { ...grades.responses }
  for (const id of marked) delete responses[id]
  return { responses }
}
