"use client"

import { useEffect, useRef, useState } from "react"
import type { Question } from "@krypta/crypto"
import { duplicateQuestion, moveQuestion } from "@/lib/question-order"
import { useQuestionReorderDrag } from "@/hooks/use-question-reorder-drag"

/*
 * Everything about changing the list of questions, and nothing about drawing
 * it.
 *
 * This lived inside FormBuilder, where roughly 190 lines of state machine sat
 * above roughly 490 lines of JSX in one 763-line component. The two have no
 * reason to share a scope: the operations here are about a Question[] and the
 * animations that accompany editing it, and none of them reads a class name.
 * It is the same split `use-form-steps.ts` already makes for the fill path.
 *
 * The removal animations are why several of these are not one-liners. A
 * removed question has to stay mounted while it fades, so the id goes into a
 * removing set first and the array is filtered after the animation. Callers
 * render from `removingIds` and `removingSectionIds` and otherwise never think
 * about it.
 */

const QUESTION_REMOVE_ANIMATION_MS = 130
const BROKEN_HIGHLIGHT_MS = 1000

const OPTION_BASED_TYPES: Question["type"][] = [
  "multiple_choice",
  "checkboxes",
  "dropdown",
]

/**
 * Ids of every question whose condition points at something that is not an
 * earlier question in this exact array. Computed for both the old and the new
 * order so a reorder can tell what *it* broke from what was already dangling.
 */
function danglingConditionIds(list: Question[]): Set<string> {
  const seen = new Set<string>()
  const dangling = new Set<string>()
  for (const question of list) {
    const source = question.condition?.questionId
    if (source !== undefined && !seen.has(source)) dangling.add(question.id)
    seen.add(question.id)
  }
  return dangling
}

/**
 * Module level so the hook body never references a function declared below it,
 * and so an effect can call it without it becoming a dependency.
 */
function fadeHighlightSoon(
  timer: React.RefObject<number | null>,
  setHighlightedId: (id: string | null) => void
) {
  if (timer.current !== null) window.clearTimeout(timer.current)
  timer.current = window.setTimeout(() => {
    timer.current = null
    setHighlightedId(null)
  }, BROKEN_HIGHLIGHT_MS)
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

interface FormQuestions {
  addQuestion: () => void
  duplicateQuestionById: (id: string) => void
  updateQuestion: (id: string, patch: Partial<Question>) => void
  changeQuestionType: (id: string, type: Question["type"]) => void
  toggleSectionBreak: (id: string) => void
  removeOption: (questionId: string, index: number) => void
  removeQuestion: (id: string) => void
  moveQuestionTo: (id: string, toIndex: number, announce?: boolean) => void
  /** Mounted but fading out, so the card is still rendered. */
  removingIds: Set<string>
  removingSectionIds: Set<string>
  /** Rung briefly on the one question a reorder just left dangling. */
  highlightedId: string | null
  /** Live-region text for the keyboard reorder path. */
  reorderMessage: string
  registerCard: ReturnType<typeof useQuestionReorderDrag>["registerCard"]
  draggingId: string | null
  handlePointerDown: ReturnType<
    typeof useQuestionReorderDrag
  >["handlePointerDown"]
}

export function useFormQuestions(
  questions: Question[],
  onQuestionsChange: (questions: Question[]) => void
): FormQuestions {
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  const [removingSectionIds, setRemovingSectionIds] = useState<Set<string>>(
    new Set()
  )
  // Set briefly on the question whose condition a reorder just broke, so the
  // eye lands on the warning that appeared. A toast would be disconnected from
  // the card the author needs to read.
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const highlightTimer = useRef<number | null>(null)
  // Announces a keyboard move; a visual reflow tells a screen-reader nothing.
  const [reorderMessage, setReorderMessage] = useState("")
  const announceParity = useRef(false)
  // Mirrors `draggingId` for the reorder path, which runs from a pointer event
  // rather than from a render and so cannot read the state directly.
  const draggingRef = useRef(false)

  // Mirrors the latest committed `questions` so the delayed branch of
  // `removeQuestion` filters current state rather than the array captured when
  // the click happened. Synced in an effect, not during render: refs must not
  // be written while rendering, and the read is 130ms later so post-commit is
  // soon enough.
  const questionsRef = useRef(questions)
  useEffect(() => {
    questionsRef.current = questions
  }, [questions])

  function addQuestion() {
    onQuestionsChange([
      ...questions,
      { id: crypto.randomUUID(), type: "short_text", label: "" },
    ])
  }

  function applyReorder(next: Question[]) {
    // A condition whose source is no longer earlier is now dangling. The
    // evaluator fails open and the builder already renders the warning; this
    // only draws attention to it.
    //
    // Only what *this* reorder broke: a condition already dangling beforehand
    // (its source was deleted earlier, say) is not this action's doing, and
    // ringing that card would point the author at something unrelated.
    //
    // `find` stops at the first, so a reorder stranding two dependents rings
    // one. Deliberate: the ring is an attention cue, and the per-card warnings
    // still render for every broken condition.
    const before = danglingConditionIds(questions)
    const after = danglingConditionIds(next)
    const broken = next.find((q) => after.has(q.id) && !before.has(q.id))

    onQuestionsChange(next)
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current)
      highlightTimer.current = null
    }
    setHighlightedId(broken?.id ?? null)
    // The drag path calls this on every midpoint crossing, so a fade started
    // here would be over before the author releases, and mid-drag their eye is
    // on the card under the pointer, not the one that broke. Hold the ring and
    // let the drop start the fade. The keyboard path has no drag, so it fades
    // straight away.
    if (broken && !draggingRef.current) {
      fadeHighlightSoon(highlightTimer, setHighlightedId)
    }
  }

  function moveQuestionTo(id: string, toIndex: number, announce = false) {
    const next = moveQuestion(questions, id, toIndex)
    if (next === questions) return
    applyReorder(next)
    // Only the keyboard path announces. A drag crosses a midpoint per card, so
    // announcing there queues one message per crossing for a single gesture.
    if (!announce) return
    // Two moves landing on the same position produce the same sentence, and a
    // screen reader will not re-read text it has already read. An alternating
    // trailing zero-width space makes each announcement a distinct string
    // without changing a single spoken word.
    announceParity.current = !announceParity.current
    setReorderMessage(
      `Question moved to position ${toIndex + 1} of ${questions.length}` +
        (announceParity.current ? "​" : "")
    )
  }

  const { registerCard, draggingId, handlePointerDown } =
    useQuestionReorderDrag(
      questions.map((question) => question.id),
      moveQuestionTo
    )

  // `draggingId` falling back to null is the drop. Start the held ring's fade
  // there rather than mid-gesture; scheduling unconditionally is harmless when
  // nothing is highlighted, and keeps this effect free of extra dependencies.
  useEffect(() => {
    draggingRef.current = draggingId !== null
    if (draggingId === null) fadeHighlightSoon(highlightTimer, setHighlightedId)
  }, [draggingId])

  // A pending fade must not fire into an unmounted component.
  useEffect(
    () => () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current)
      }
    },
    []
  )

  function duplicateQuestionById(id: string) {
    onQuestionsChange(duplicateQuestion(questions, id, crypto.randomUUID()))
  }

  function updateQuestion(id: string, patch: Partial<Question>) {
    onQuestionsChange(
      questions.map((q) => (q.id === id ? { ...q, ...patch } : q))
    )
  }

  function toggleSectionBreak(id: string) {
    const current = questions.find((q) => q.id === id)
    if (!current?.pageBreakBefore) {
      updateQuestion(id, { pageBreakBefore: true })
      return
    }

    if (prefersReducedMotion()) {
      updateQuestion(id, { pageBreakBefore: false })
      return
    }

    setRemovingSectionIds((prev) => new Set(prev).add(id))
    setTimeout(() => {
      onQuestionsChange(
        questionsRef.current.map((q) =>
          q.id === id ? { ...q, pageBreakBefore: false } : q
        )
      )
      setRemovingSectionIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, QUESTION_REMOVE_ANIMATION_MS)
  }

  function changeQuestionType(id: string, type: Question["type"]) {
    const current = questions.find((q) => q.id === id)
    const isOptionBased = OPTION_BASED_TYPES.includes(type)
    updateQuestion(id, {
      type,
      options: isOptionBased
        ? current?.options && current.options.length > 0
          ? current.options
          : [""]
        : undefined,
    })
  }

  function removeOption(questionId: string, index: number) {
    const current = questions.find((q) => q.id === questionId)
    const options = (current?.options ?? []).filter((_, i) => i !== index)
    updateQuestion(questionId, { options: options.length > 0 ? options : [""] })
  }

  function removeQuestion(id: string) {
    if (prefersReducedMotion()) {
      onQuestionsChange(questions.filter((q) => q.id !== id))
      return
    }

    setRemovingIds((prev) => new Set(prev).add(id))
    setTimeout(() => {
      onQuestionsChange(questionsRef.current.filter((q) => q.id !== id))
      setRemovingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, QUESTION_REMOVE_ANIMATION_MS)
  }

  return {
    addQuestion,
    duplicateQuestionById,
    updateQuestion,
    changeQuestionType,
    toggleSectionBreak,
    removeOption,
    removeQuestion,
    moveQuestionTo,
    removingIds,
    removingSectionIds,
    highlightedId,
    reorderMessage,
    registerCard,
    draggingId,
    handlePointerDown,
  }
}
