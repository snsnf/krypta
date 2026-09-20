import type { Question } from "@krypta/crypto"
import { firstUnansweredIndex, type AnswerValue } from "./form-answers"
import { splitFormIntoPages } from "./form-pagination"
import { visibleQuestions } from "./form-visibility"

/**
 * What a respondent is shown at once, and when they may move on.
 *
 * Classic and Focus are two deliberately different designs, and this module is
 * what they share: the step machine, never the look. Both layouts used to
 * carry their own copy of the position, the resume, the end-of-form test and
 * both advance gates, written differently enough that a grep for one never
 * found the other. A rule added to one silently missed the other.
 *
 * So the machine answers in neutral terms and each layout words and draws the
 * answer its own way. `stepBlockedBy` returns a reason rather than a sentence
 * precisely because Focus says "This question is required." about the one
 * question on screen while Classic says "Answer every required question to
 * continue." about a page of them. Nothing here should ever grow a class name,
 * a label or a piece of copy.
 *
 * It is pure and layout-agnostic on purpose. The unit suite here has no DOM,
 * so anything living inside a renderer can only be reached through Playwright;
 * everything in this file is assertable in milliseconds.
 */

/** Which shape of step a layout wants. */
export type FormLayout = "classic" | "focus"

/** The questions shown together. One per step in Focus, a page in Classic. */
export type FormStep = Question[]

/** Why the respondent cannot leave this step yet, or null when they can. */
export type StepBlock = "required" | "uploading"

/**
 * Splits already-visible questions into steps.
 *
 * Private on purpose. Visibility has to run before this, and callers used to
 * have to know that: three of them remembered, and a fourth that forgot would
 * have got no type error and a silently wrong page count, or in Classic an
 * empty page a respondent has to click through. `buildVisibleSteps` is the
 * only way in, so the order is not something a caller can get wrong.
 *
 * The two layouts disagree about an empty form, and both are kept as they
 * were: Focus produces no steps at all, which is what drives its "no questions
 * yet" screen, while Classic produces one empty page and renders a form with
 * nothing in it.
 */
function buildSteps(questions: Question[], layout: FormLayout): FormStep[] {
  return layout === "focus"
    ? questions.map((question) => [question])
    : splitFormIntoPages(questions)
}

/**
 * The steps a respondent should currently see: visibility first, then the
 * split into steps, in that order and only in that order.
 *
 * The two operations are not independent. A question hidden by a condition
 * must not take a step of its own in Focus, and must not leave a page behind
 * in Classic that has nothing on it. Filtering afterwards cannot fix either,
 * because by then the steps have already been shaped around questions that
 * are not there.
 */
export function buildVisibleSteps(
  questions: Question[],
  answers: Record<string, AnswerValue | undefined>,
  layout: FormLayout
): FormStep[] {
  return buildSteps(visibleQuestions(questions, answers), layout)
}

/**
 * The step to open on: the one holding the first unanswered question.
 *
 * A respondent coming back to a saved draft starts where they stopped rather
 * than clicking forward through work they have already done. With no draft
 * every answer is empty, so this is 0 and both layouts behave exactly as they
 * did before drafts existed.
 *
 * Derived from the answers, never stored, so there is no index that can point
 * at a question the creator has since deleted.
 */
export function initialStepIndex(
  steps: FormStep[],
  answers: Record<string, AnswerValue | undefined>
): number {
  const questions = steps.flat()
  const target = questions[firstUnansweredIndex(questions, answers)]
  if (!target) return 0
  const index = steps.findIndex((step) =>
    step.some((question) => question.id === target.id)
  )
  return index === -1 ? 0 : index
}

/**
 * Keeps an index inside the steps that exist.
 *
 * A defensive clamp that cannot currently fire, kept deliberately. The visible
 * list shrinks whenever an answer hides a question, so in principle a held
 * index can point past the end. It cannot today: a condition may only name an
 * EARLIER question, so answering at position k only ever hides questions after
 * k, and the respondent is standing at k, so the list stays at least k+1 long.
 * That invariant is enforced by the evaluator, where a later-referencing
 * condition fails open, rather than by the builder, so it holds for
 * already-published forms too.
 *
 * Keep it anyway. The day anything relaxes earlier-only references this
 * becomes load-bearing overnight, and its absence surfaces as a blank Focus
 * screen: the failure mode hardest to attribute to its cause. It lives here
 * now rather than in one renderer, so Classic is covered by it too, which it
 * previously was not.
 */
export function clampStepIndex(steps: FormStep[], index: number): number {
  return Math.min(index, Math.max(0, steps.length - 1))
}

/**
 * Whether this step may be left, and if not, why.
 *
 * An unfinished upload is reported ahead of a missing required answer because
 * that is the more specific thing to say: the file question is answered as far
 * as the respondent is concerned, and telling them it is required would send
 * them looking for a field they have already filled in.
 */
export function stepBlockedBy(
  step: FormStep,
  uploadingIds: Set<string>,
  missingRequired: (questions: Question[]) => boolean
): StepBlock | null {
  if (
    step.some(
      (question) =>
        question.type === "file_upload" && uploadingIds.has(question.id)
    )
  ) {
    return "uploading"
  }
  return missingRequired(step) ? "required" : null
}
