import type { Question } from "@krypta/crypto"
import type { AnswerValue } from "./form-answers"

/**
 * The only question types a condition can meaningfully name: a condition
 * matches an option string, so the source has to offer options. The builder
 * offers only these, but a published schema can still carry a condition whose
 * source was later switched to a free-text type.
 */
const CONDITION_SOURCE_TYPES = new Set<Question["type"]>([
  "multiple_choice",
  "dropdown",
  "checkboxes",
])

function isUsableSource(question: Question | undefined): boolean {
  if (question === undefined) return false
  if (!CONDITION_SOURCE_TYPES.has(question.type)) return false
  return (question.options?.length ?? 0) > 0
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
        const hit = answerMatches(answers[condition.questionId], condition.value)
        show = condition.operator === "is" ? hit : !hit
      }
    }

    decided.set(question.id, { question, visible: show })
    if (show) visible.push(question)
  }

  return visible
}
