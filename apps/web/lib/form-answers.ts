/**
 * The shape of a decrypted response answer.
 *
 * These live in `lib/` rather than in a page component so pure modules (the
 * response summary in particular) can import them, and so there is one
 * definition rather than two that drift when a question type is added.
 *
 * Not in `packages/crypto`: `FileAnswer` references an `attachmentId`, which
 * is an application concept rather than a cryptographic one.
 */
import type { Question } from "@krypta/crypto"
import { displayAnswer, isEmptyOtherAnswer, isOtherAnswer } from "./form-other"

export interface FileAnswer {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
}

export type AnswerValue = string | string[] | FileAnswer

export function isFileAnswer(
  value: AnswerValue | undefined
): value is FileAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "attachmentId" in value
  )
}

/**
 * An answer as a response table cell or CSV field shows it: a file by its
 * name, and a written-in Other answer as what the respondent wrote. The raw
 * value of an Other answer carries a U+0000 marker, and joining raw values
 * put that marker in front of the owner in both places.
 */
export function formatAnswer(value: AnswerValue | undefined): string {
  if (value === undefined) return ""
  if (isFileAnswer(value)) return value.filename
  if (Array.isArray(value)) return value.map(displayAnswer).join(", ")
  return displayAnswer(value)
}

/**
 * Whether a question has been left blank.
 *
 * An Other selection with nothing written in it does not count. Otherwise a
 * required question is satisfied by ticking a box and typing nothing, which is
 * precisely what the box exists to collect.
 */
export function isAnswerEmpty(value: AnswerValue | undefined): boolean {
  if (Array.isArray(value)) {
    return value.filter((entry) => !isEmptyOtherAnswer(entry)).length === 0
  }
  if (value && typeof value === "object") return false
  if (typeof value === "string" && isEmptyOtherAnswer(value)) return true
  return !value
}

/**
 * The question a respondent should be put in front of when they come back to a
 * partly filled form: the first one they have not answered.
 *
 * This is what makes a restored draft usable in the Focus layout, where the
 * respondent would otherwise land on question one and click forward through
 * everything they have already done. Deriving the position from the answers
 * rather than storing it also means there is no second thing to keep in sync,
 * and no stored index that can point at a question the creator has since
 * deleted.
 *
 * A fully answered form returns the last index, which in Focus is the step
 * carrying the submit button. An empty form returns 0, which is where both
 * layouts started before drafts existed.
 */
export function firstUnansweredIndex(
  questions: Question[],
  answers: Record<string, AnswerValue | undefined>
): number {
  if (questions.length === 0) return 0
  const index = questions.findIndex((q) => isAnswerEmpty(answers[q.id]))
  return index === -1 ? questions.length - 1 : index
}


/**
 * Whether a choice question still offers this exact stored value.
 *
 * A written-in Other answer is legal only where Other is actually on offer.
 * `allowOther` is documented as meaningful on multiple choice and checkboxes
 * alone, so a marked value against any other type is a leftover from an edit
 * rather than something a respondent could produce today.
 */
function choiceIsOnOffer(question: Question, value: string): boolean {
  if (isOtherAnswer(value)) {
    return (
      question.allowOther === true &&
      (question.type === "multiple_choice" || question.type === "checkboxes")
    )
  }
  return (question.options ?? []).includes(value)
}

/**
 * The part of a stored answer this question can still hold, or null when none
 * of it survives.
 */
function keepableAnswer(
  question: Question,
  value: AnswerValue
): AnswerValue | null {
  switch (question.type) {
    case "short_text":
    case "long_text":
    case "number":
    case "email":
    case "date":
      // Deliberately no check that a number parses or an email has an address
      // in it. A wrong-looking string lands in a field the respondent can see
      // and correct, and the required gate plus the browser's own validation
      // already stop it at submit. Dropping it would delete recoverable work.
      return typeof value === "string" && !isOtherAnswer(value) ? value : null
    case "multiple_choice":
    case "dropdown":
      if (typeof value !== "string") return null
      return choiceIsOnOffer(question, value) ? value : null
    case "checkboxes": {
      if (!Array.isArray(value)) return null
      const kept = value.filter((entry) => choiceIsOnOffer(question, entry))
      if (kept.length === 0) return null
      return kept.length === value.length ? value : kept
    }
    case "file_upload":
      return isFileAnswer(value) ? value : null
    default:
      // A question type this build does not know about, from a form built by a
      // newer one. Failing open matches how an unresolvable visibility
      // condition is treated: keep the answer rather than delete work over a
      // type we are not in a position to judge.
      return value
  }
}

/**
 * Drops the parts of a restored draft the form can no longer hold.
 *
 * A draft is only meaningful against the schema it was typed into, and the two
 * arrive at different times: answers are restored during the first render, from
 * storage, while the questions are still being fetched and decrypted. So this
 * is a second step rather than something `loadDraft` could do, and it runs the
 * moment the schema lands.
 *
 * Without it a stale value survives every gate that should have caught it. Turn
 * a short text question into multiple choice and yesterday's sentence is still
 * a string, so it restores; it is not empty, so the resume position skips the
 * question and `required` counts it as answered; but no option matches it, so
 * every radio renders unselected. The respondent sees a blank question they are
 * not asked to fill in, and the sentence is sealed into their response. If that
 * question drives a visibility condition they are also routed by an answer they
 * cannot see.
 *
 * Three properties this must keep:
 *
 * It is subtractive only. Entries are dropped, never added or rewritten to
 * something the respondent did not type, which is what keeps it clear of the
 * sealing path: the payload built at submit can only shrink.
 *
 * It matches against every question, not the visible ones. An answer to a
 * question hidden by a condition is deliberately kept, because toggling a
 * branch back and forth must not destroy work.
 *
 * It returns the same object when nothing was dropped, so an ordinary restore
 * costs no render and no write, and running it twice is a no-op.
 */
export function reconcileDraft(
  questions: Question[],
  answers: Record<string, AnswerValue>
): Record<string, AnswerValue> {
  const byId = new Map(questions.map((question) => [question.id, question]))
  const next: Record<string, AnswerValue> = {}
  let changed = false

  for (const [id, value] of Object.entries(answers)) {
    const question = byId.get(id)
    if (!question) {
      // The question was deleted. The answer can never be rendered and is
      // already filtered out of the sealed payload, so it is content sitting on
      // the device with nothing left that could read it.
      changed = true
      continue
    }
    const kept = keepableAnswer(question, value)
    if (kept === null) {
      changed = true
      continue
    }
    if (kept !== value) changed = true
    next[id] = kept
  }

  return changed ? next : answers
}
