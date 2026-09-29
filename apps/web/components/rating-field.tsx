"use client"

import { useState } from "react"
import type { Question } from "@krypta/crypto"
import { cn } from "@/lib/utils"
import { parseRatingAnswer, ratingRange } from "@/lib/question-rating"

/*
 * A rating is a radio group underneath, like multiple choice: the radios are
 * sr-only, the stars or numbered boxes are their labels, and arrow keys move
 * between values natively. Classic and Focus both render it through
 * FormQuestionField, and the builder renders it in `preview` mode, so what the
 * creator sees is exactly what a respondent gets.
 *
 * Each value shrinks with `flex-1 min-w-0` rather than having a fixed width:
 * eleven boxes (0 to 10) or ten stars have to fit a 375px phone without the
 * page scrolling sideways.
 */

// Our own path rather than a hugeicon: those are stroke-only, and a star has
// to be fillable to show the chosen value.
const STAR_PATH =
  "M12 2.8l2.83 5.73 6.33.92-4.58 4.46 1.08 6.3L12 17.24l-5.66 2.97 1.08-6.3-4.58-4.46 6.33-.92z"

// The radio is sr-only, so its own focus ring is invisible: the label carries
// it, as the multiple choice rows do (WCAG 2.4.7).
const FOCUS_RING =
  "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"

interface RatingFieldProps {
  question: Question
  value: string | undefined
  onChange?: (value: string) => void
  /** The builder's picture of the field: drawn, never focused or announced. */
  preview?: boolean
}

export function RatingField({
  question,
  value,
  onChange,
  preview = false,
}: RatingFieldProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const range = ratingRange(question)
  const picked = parseRatingAnswer(question, value)
  const values = Array.from(
    { length: range.max - range.min + 1 },
    (_, i) => range.min + i
  )
  const stars = range.style === "stars"
  // Hovering previews the fill; leaving falls back to the chosen value.
  const lit = hovered ?? picked ?? 0

  return (
    <div
      role={preview ? undefined : "radiogroup"}
      aria-label={preview ? undefined : question.label}
      aria-hidden={preview ? true : undefined}
      className="w-full"
    >
      <div
        className={cn(
          "flex w-full",
          stars ? "max-w-sm gap-1" : "gap-1 sm:gap-1.5"
        )}
        onMouseLeave={() => setHovered(null)}
      >
        {values.map((option, index) => {
          const name = stars
            ? `${option} of ${range.max} stars`
            : `${option}, on a scale of ${range.min} to ${range.max}`
          return (
            <label
              key={option}
              onMouseEnter={preview ? undefined : () => setHovered(option)}
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer items-center justify-center transition-colors duration-150 ease-out",
                FOCUS_RING,
                preview && "pointer-events-none",
                stars
                  ? cn(
                      "max-w-10 rounded-md p-0.5",
                      option <= lit
                        ? "text-[var(--form-accent)]"
                        : "text-muted-foreground/40"
                    )
                  : "form-theme-text h-10 rounded-lg border border-border text-sm tabular-nums hover:bg-foreground/[0.05] has-[:checked]:border-transparent has-[:checked]:bg-[var(--form-accent)] has-[:checked]:text-[var(--form-accent-foreground)]"
              )}
            >
              <input
                type="radio"
                name={preview ? `${question.id}-preview` : question.id}
                value={String(option)}
                aria-label={name}
                checked={picked === option}
                // One required radio is enough for the browser to require the
                // group, and repeating it adds nothing.
                required={!preview && question.required === true && index === 0}
                disabled={preview}
                tabIndex={preview ? -1 : undefined}
                onChange={() => onChange?.(String(option))}
                className="sr-only"
              />
              {stars ? (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="aspect-square w-full"
                >
                  <path
                    d={STAR_PATH}
                    fill={option <= lit ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <span aria-hidden="true">{option}</span>
              )}
            </label>
          )
        })}
      </div>
      {!stars && (range.minLabel || range.maxLabel) && (
        <div className="form-theme-text mt-1.5 flex justify-between gap-4 text-xs text-muted-foreground">
          <span>{range.minLabel}</span>
          <span className="text-right">{range.maxLabel}</span>
        </div>
      )}
    </div>
  )
}
