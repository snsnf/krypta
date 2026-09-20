"use client"

import { useState } from "react"
import type { Question } from "@krypta/crypto"
import type { AnswerValue } from "../lib/form-answers"
import {
  buildVisibleSteps,
  clampStepIndex,
  initialStepIndex,
  stepBlockedBy,
  type FormLayout,
  type FormStep,
  type StepBlock,
} from "../lib/form-steps"

interface UseFormStepsOptions {
  /**
   * Every question on the form, unfiltered. Visibility is applied here rather
   * than by the caller, so the order it has to run in is not something a
   * caller can get wrong.
   */
  questions: Question[]
  answers: Record<string, AnswerValue>
  layout: FormLayout
  uploadingIds: Set<string>
  missingRequired: (questions: Question[]) => boolean
  onSubmit: (event: React.FormEvent) => void
}

/**
 * The wiring around `lib/form-steps.ts`: which step is current, and moving
 * between them.
 *
 * Deliberately thin. Every decision worth testing is in the pure module, and
 * this holds the one piece of React state that cannot be, so the layouts get
 * the same machine without either of them owning it.
 *
 * The state stays inside whichever renderer calls this, which is what lets the
 * preview reset both layouts by remounting them with a key. Lifting it to the
 * callers would widen their interface rather than narrow it, for a reset that
 * React already expresses.
 */
export function useFormSteps({
  questions,
  answers,
  layout,
  uploadingIds,
  missingRequired,
  onSubmit,
}: UseFormStepsOptions) {
  const steps = buildVisibleSteps(questions, answers, layout)
  /*
   * The initializer, not an effect. This has to be the first index rendered,
   * or the respondent sees the top of the form for a frame, and it must not
   * re-run afterwards, or answering a question would throw them forward the
   * moment they filled one in mid-form.
   */
  const [index, setIndex] = useState(() => initialStepIndex(steps, answers))
  /*
   * +1 advancing, -1 going back. Which way the respondent moved is part of the
   * machine; what that looks like is not. Focus reads this to send a question
   * out the way the next one comes in, and Classic ignores it.
   */
  const [direction, setDirection] = useState<1 | -1>(1)

  const safeIndex = clampStepIndex(steps, index)
  const current: FormStep | undefined = steps[safeIndex]
  const isLast = safeIndex === steps.length - 1
  const blockedBy: StepBlock | null = current
    ? stepBlockedBy(current, uploadingIds, missingRequired)
    : null

  function advance() {
    setDirection(1)
    setIndex(safeIndex + 1)
  }

  function back() {
    setDirection(-1)
    setIndex(safeIndex - 1)
  }

  /**
   * Advance, or submit on the last step. Both layouts do exactly this, and
   * both used to spell it out, which is how their two upload gates drifted
   * apart in the first place.
   */
  function submitStep(event: React.FormEvent) {
    event.preventDefault()
    if (blockedBy !== null) return
    if (isLast) {
      onSubmit(event)
    } else {
      advance()
    }
  }

  return {
    steps,
    index: safeIndex,
    current,
    isLast,
    blockedBy,
    direction,
    back,
    submitStep,
  }
}
