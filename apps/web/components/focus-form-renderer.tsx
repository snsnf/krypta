"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import type { Question } from "@krypta/crypto"
import { Bezel } from "@/components/bezel"
import { Button } from "@/components/ui/button"
import {
  FormQuestionField,
  optionShortcutIndex,
} from "@/components/form-question-field"
import { useFormSteps } from "@/hooks/use-form-steps"
import type { AnswerValue } from "@/hooks/use-public-form-answers"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight02Icon } from "@hugeicons/core-free-icons"
import { distinctOptions } from "@/lib/question-options"
import { useFormLanguage, useFormT } from "@/lib/form-i18n"
import { usesNumericShortcuts } from "@/lib/form-language"

interface FocusFormRendererProps {
  title: string
  questions: Question[]
  answers: Record<string, AnswerValue>
  onAnswerChange: (qid: string, value: AnswerValue) => void
  onToggleCheckbox: (qid: string, opt: string) => void
  onFileSelect: (qid: string, file: File | undefined) => void
  uploadingIds: Set<string>
  uploadErrors: Record<string, string>
  missingRequired: (questions: Question[]) => boolean
  submitting: boolean
  submitError: string | null
  onSubmit: (e: React.FormEvent) => void
}

/*
 * This component server-renders, and useLayoutEffect warns there because it
 * cannot run before a paint that never happens. The measurement it guards has
 * to be pre-paint on the client, though, or the card animates up from nothing
 * on first load, so the effect is swapped rather than downgraded everywhere.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect

export function FocusFormRenderer({
  title,
  questions,
  answers,
  onAnswerChange,
  onToggleCheckbox,
  onFileSelect,
  uploadingIds,
  uploadErrors,
  missingRequired,
  submitting,
  submitError,
  onSubmit,
}: FocusFormRendererProps) {
  const t = useFormT()
  // Arabic keyboards do not type Latin letters, so an Arabic form's option
  // shortcuts are numbers; the badges in FormQuestionField follow the same
  // language, so the two cannot disagree.
  const numericShortcuts = usesNumericShortcuts(useFormLanguage())
  /*
   * Position, resume, the end-of-form test and both advance gates come from
   * the shared step machine. What Focus keeps for itself is everything below:
   * one question on screen, the nested enclosure, the measured-height morph,
   * the letter shortcuts and its own wording for why the button is disabled.
   */
  const {
    steps,
    index,
    current,
    isLast,
    blockedBy,
    direction,
    back,
    submitStep,
  } = useFormSteps({
    questions,
    answers,
    layout: "focus",
    uploadingIds,
    missingRequired,
    onSubmit,
  })
  const reduceMotion = useReducedMotion()
  const formRef = useRef<HTMLFormElement>(null)

  /*
   * The card's height is measured and animated as a number rather than morphed
   * with Motion's layout prop. layout animates the box with a transform, and
   * scaling a tall card down to a short one visibly shears its border and
   * corners on the way. Height costs a layout pass per frame; the card is one
   * element and the distortion was the worse trade.
   *
   * useLayoutEffect for the first measurement so the height is set before
   * paint, otherwise the card animates up from nothing on load.
   */
  const questionRef = useRef<HTMLDivElement>(null)
  const [cardHeight, setCardHeight] = useState<number | null>(null)

  useIsomorphicLayoutEffect(() => {
    const element = questionRef.current
    if (!element) return
    const sync = () => setCardHeight(element.getBoundingClientRect().height)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // One question per step in this layout, so a step is its single question.
  const question = current?.[0]
  const stillUploading = blockedBy === "uploading"
  const invalid = blockedBy !== null

  /*
   * The A/B/C badges are a promise that the letters do something, so make them
   * do it. Only one question is on screen in this layout, which is what makes
   * a window-level shortcut unambiguous; Classic could not do this and shows a
   * plain radio instead.
   *
   * The listener sits on window rather than the card because the radios are
   * sr-only and focus can legitimately be on the body. Typing must still win:
   * a text field, textarea, select or contenteditable swallows the key, while
   * a focused radio or checkbox does not, since those accept no text and a
   * respondent who just picked A must still be able to press B.
   */
  useEffect(() => {
    if (question?.type !== "multiple_choice" && question?.type !== "checkboxes")
      return
    const options = distinctOptions(question.options)
    if (options.length === 0) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLTextAreaElement) return
      if (target instanceof HTMLSelectElement) return
      if (target instanceof HTMLElement && target.isContentEditable) return
      if (
        target instanceof HTMLInputElement &&
        target.type !== "radio" &&
        target.type !== "checkbox"
      )
        return

      const index = optionShortcutIndex(
        event.key,
        options.length,
        numericShortcuts
      )
      if (index === -1) return
      event.preventDefault()
      const option = options[index]
      if (question.type === "checkboxes") {
        onToggleCheckbox(question.id, option)
      } else {
        onAnswerChange(question.id, option)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [question, onAnswerChange, onToggleCheckbox, numericShortcuts])

  /*
   * Enter advances when nothing on the page owns the key.
   *
   * The option shortcuts are window-level, so choosing with a letter leaves
   * focus on the body, and a form only submits implicitly from a focused
   * control. The screen then says "press Enter" while Enter does nothing, and
   * the respondent has to reach for the button.
   *
   * Restricted to the body for exactly that reason: a focused input, radio or
   * button already submits the form on Enter, and handling it here as well
   * would advance two questions on one press.
   */
  useEffect(() => {
    function onEnter(event: KeyboardEvent) {
      if (event.key !== "Enter") return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return
      if (event.target !== document.body) return
      event.preventDefault()
      formRef.current?.requestSubmit()
    }
    window.addEventListener("keydown", onEnter)
    return () => window.removeEventListener("keydown", onEnter)
  }, [])

  if (!question) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center">
        <p
          dir="auto"
          className="form-theme-text mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          {title || t("untitled")}
        </p>
        <p className="form-theme-text text-muted-foreground">
          {t("noQuestions")}
        </p>
      </div>
    )
  }

  /*
   * The badges imply the letters do something, but only to someone who has
   * used Typeform. Say it once, under the options. Deliberately not a range
   * like "A to C": the badges are on screen, and a range would have to be
   * recomputed past the twenty-sixth option where they stop being letters.
   */
  const shortcutHint =
    (question.options?.length ?? 0) === 0
      ? null
      : question.type === "checkboxes"
        ? numericShortcuts
          ? t("pressNumberToggle")
          : t("pressLetterToggle")
        : question.type === "multiple_choice"
          ? numericShortcuts
            ? t("pressNumberChoose")
            : t("pressLetterChoose")
          : null

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center">
      {/*
       * Title and position share a row. The count is not decoration: Focus
       * shows one question at a time, so without it a respondent cannot tell
       * whether they are two questions from the end or twenty, which is the
       * one thing the progress bar communicates only vaguely.
       */}
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <p
          dir="auto"
          className="form-theme-text text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          {title || t("untitled")}
        </p>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {String(index + 1).padStart(2, "0")}
          <span className="opacity-40"> / </span>
          {String(steps.length).padStart(2, "0")}
        </p>
      </div>
      <div className="mb-10 h-1 w-full overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--form-accent)_14%,transparent)]">
        <div
          className="form-theme-accent-bg h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${((index + 1) / steps.length) * 100}%` }}
        />
      </div>

      {/*
       * No key on the form: it has to survive the step change so the card can
       * morph between question heights rather than snap. Only the question
       * inside is keyed.
       */}
      <form ref={formRef} onSubmit={submitStep}>
        {/*
         * Nested enclosure rather than a single card. Focus shows one question
         * at a time, so the card is the whole screen here and can afford the
         * weight; Classic lists many and cannot.
         *
         * surface="token" because a form draws its own colours: the creator
         * picks them, and the mode is theirs rather than the dashboard's.
         */}
        <Bezel
          surface="token"
          radius="calc(var(--radius) * 2.4)"
          className="border-[color-mix(in_oklab,var(--form-accent)_20%,transparent)] bg-[color-mix(in_oklab,var(--form-accent)_9%,transparent)] shadow-[0_28px_70px_-32px_color-mix(in_oklab,var(--form-accent)_55%,transparent)]"
          innerClassName="border-[color-mix(in_oklab,var(--form-accent)_12%,transparent)] p-8 sm:p-10"
        >
          {/*
           * Clipped, because popLayout mounts the incoming question at full
           * size straight away: growing from short to tall would otherwise
           * spill it over the button below for the length of the animation.
           * The measured element carries a little bottom padding so a focus
           * ring on the last field is not clipped by that same overflow.
           * It is also a flow-root, so a child's margin cannot collapse out
           * through it: with an empty question label the field's top margin
           * did exactly that, the measurement came up 24px short, and the
           * overflow cut the bottom off the field.
           */}
          <div
            className="-mx-2 overflow-hidden px-2 transition-[height] duration-[280ms] ease-in-out motion-reduce:transition-none"
            style={cardHeight === null ? undefined : { height: cardHeight }}
          >
            <div ref={questionRef} className="flow-root pb-1.5">
              <AnimatePresence
                mode="popLayout"
                initial={false}
                custom={direction}
              >
                <motion.div
                  key={index}
                  custom={direction}
                  initial={
                    reduceMotion
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          transform: `translateY(${direction > 0 ? 18 : -18}px)`,
                        }
                  }
                  animate={{ opacity: 1, transform: "translateY(0px)" }}
                  exit={
                    reduceMotion
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          transform: `translateY(${direction > 0 ? -14 : 14}px)`,
                        }
                  }
                  transition={{
                    duration: reduceMotion ? 0.12 : 0.2,
                    ease: [0.23, 1, 0.32, 1],
                  }}
                >
                  <label
                    htmlFor={question.id}
                    dir="auto"
                    className="form-theme-header block font-medium whitespace-pre-line"
                  >
                    {question.label}
                    {question.required && (
                      <span className="form-theme-accent-text ms-1">*</span>
                    )}
                  </label>

                  <div className="mt-6">
                    <FormQuestionField
                      question={question}
                      value={answers[question.id]}
                      onChange={(value) => onAnswerChange(question.id, value)}
                      onToggleCheckbox={(opt) =>
                        onToggleCheckbox(question.id, opt)
                      }
                      onFileSelect={(file) => onFileSelect(question.id, file)}
                      uploading={uploadingIds.has(question.id)}
                      uploadError={uploadErrors[question.id]}
                    />
                  </div>
                  {/* Hidden without a fine pointer: there is no keyboard to press
                  on a phone, and the hint would be a promise the device cannot
                  keep. */}
                  {shortcutHint && (
                    <p className="form-theme-text mt-4 hidden text-xs text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:block">
                      {shortcutHint}
                    </p>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </Bezel>

        {submitError && isLast && (
          <p
            aria-live="polite"
            className="form-theme-text mt-4 text-destructive"
          >
            {submitError}
          </p>
        )}

        <div className="mt-8 flex items-center gap-4">
          <Button
            type="submit"
            disabled={submitting || invalid}
            className="form-theme-accent-bg form-theme-button form-theme-text active:scale-[0.97]"
          >
            {submitting && isLast ? (
              t("submitting")
            ) : isLast ? (
              t("submit")
            ) : (
              <>
                {t("next")}
                <HugeiconsIcon
                  icon={ArrowRight02Icon}
                  size={16}
                  strokeWidth={2}
                  className="rtl:rotate-180"
                />
              </>
            )}
          </Button>
          {/*
           * Deliberately plain text rather than a drawn keycap. A bordered key
           * sits directly beside the submit button, and at that size the two
           * boxes competed: the hint read as a second control rather than as a
           * note about the first.
           *
           * It yields to the reason the button is disabled, because telling
           * someone to press Enter while Enter does nothing is worse than
           * saying nothing. Hidden without a fine pointer for the same reason
           * the option shortcut hint is: a phone has no key to press.
           */}
          {invalid && !submitting ? (
            <span className="form-theme-text text-xs text-muted-foreground">
              {stillUploading
                ? t("waitingUpload")
                : t("questionRequired")}
            </span>
          ) : (
            <span className="form-theme-text hidden text-xs text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:inline">
              {t("pressEnter")} ↵
            </span>
          )}
          {index > 0 && (
            <button
              type="button"
              onClick={back}
              className="form-theme-text ms-auto text-sm text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
            >
              <span aria-hidden="true" className="inline-block rtl:rotate-180">
                ←
              </span>{" "}
              {t("back")}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
