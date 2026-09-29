import type { Question, QuestionCondition } from "@krypta/crypto"
import type { AnswerValue } from "./form-answers"
import { parseRatingAnswer, ratingValues } from "./question-rating"

/**
 * Choice questions whose options a condition can match. Free text is left out
 * because exact-matching it breaks silently on case and whitespace.
 */
const CHOICE_SOURCE_TYPES = new Set<Question["type"]>([
  "multiple_choice",
  "dropdown",
  "checkboxes",
])

/**
 * The values a condition source can take, or null when the question cannot be
 * a source. The builder offers exactly these in its value picker and warns
 * when a saved value is not among them, so the editor and this evaluator
 * cannot disagree about what a usable source is. A published schema can still
 * carry a condition whose source was later switched to a free-text type, which
 * is why the evaluator asks too.
 */
export function conditionValues(question: Question | undefined): string[] | null {
  if (question === undefined) return null
  if (question.type === "rating") return ratingValues(question)
  if (!CHOICE_SOURCE_TYPES.has(question.type)) return null
  const options = question.options ?? []
  return options.length > 0 ? options : null
}

export function isRangeOperator(operator: QuestionCondition["operator"]): boolean {
  return operator === "at_most" || operator === "at_least"
}

function isUsableSource(question: Question | undefined): boolean {
  return conditionValues(question) !== null
}

/**
 * A `checkboxes` answer is an array, so matching it against a single option
 * means membership. Every other source type stores a single string.
 */
function answerMatches(answer: AnswerValue | undefined, value: string): boolean {
  if (Array.isArray(answer)) return answer.includes(value)
  return answer === value
}

/**
 * Whether a condition holds against a visible, usable source.
 *
 * A range bound outside the source's range never matches, the same as an
 * `is` naming a removed option, which is what the builder's "never matches"
 * warning promises. Anything this build cannot judge (a range operator on a
 * choice source, or an operator from a newer build) fails open, like every
 * other unresolvable condition: a question silently vanishing from a live form
 * loses data the author believes they are collecting.
 */
function conditionHolds(
  condition: QuestionCondition,
  source: Question,
  answer: AnswerValue | undefined
): boolean {
  switch (condition.operator) {
    case "is":
      return answerMatches(answer, condition.value)
    case "is_not":
      return !answerMatches(answer, condition.value)
    case "at_most":
    case "at_least": {
      if (source.type !== "rating") return true
      if (!ratingValues(source).includes(condition.value)) return false
      const picked = parseRatingAnswer(source, answer)
      if (picked === null) return false
      const bound = Number(condition.value)
      return condition.operator === "at_most" ? picked <= bound : picked >= bound
    }
    default:
      return true
  }
}

/**
 * The questions a respondent should currently see, in document order.
 *
 * Derived, never stored: it is a pure function of the questions and the
 * answers so far, so it cannot go stale.
 *
 * One pass in document order gives three of the spec's rules for free:
 * a condition may only name an EARLIER question, so by the time a dependent
 * is evaluated its source's visibility is already decided (transitive
 * hiding); and a reference that is not resolvable to a usable source (a
 * deleted question, a later one, or one whose type no longer offers options)
 * fails open.
 */
export function visibleQuestions(
  questions: Question[],
  answers: Record<string, AnswerValue | undefined>
): Question[] {
  const decided = new Map<string, { question: Question; visible: boolean }>()
  const visible: Question[] = []

  for (const question of questions) {
    const condition = question.condition
    let show = true

    if (condition) {
      const source = decided.get(condition.questionId)
      if (source === undefined || !isUsableSource(source.question)) {
        // Names a deleted question, one that reordering moved later, or one
        // whose type was changed so it no longer offers options to match.
        // Fail open: a question silently vanishing from a live form loses
        // data the author believes they are collecting.
        show = true
      } else if (!source.visible) {
        show = false
      } else {
        show = conditionHolds(
          condition,
          source.question,
          answers[condition.questionId]
        )
      }
    }

    decided.set(question.id, { question, visible: show })
    if (show) visible.push(question)
  }

  return visible
}
