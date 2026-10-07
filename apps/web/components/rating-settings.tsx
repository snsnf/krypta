"use client"

import type { Question, RatingSettings } from "@krypta/crypto"
import { cn } from "@/lib/utils"
import {
  DEFAULT_RATING,
  DEFAULT_SCALE,
  SCALE_ENDS,
  STAR_COUNTS,
  ratingRange,
} from "@/lib/question-rating"
import { RatingField } from "@/components/rating-field"
import { useAppT } from "@/lib/app-i18n"
import { autoDir } from "@/lib/text-direction"

const SMALL_SELECT_CLASSES =
  "h-7 rounded-md border border-border bg-background px-2 text-sm"

const LABEL_INPUT_CLASSES =
  "w-full border-0 border-b border-border/60 bg-transparent px-0 py-1 text-sm outline-none transition-colors duration-150 ease-out placeholder:text-muted-foreground/60 focus:border-border"

function withLabel(
  range: RatingSettings,
  key: "minLabel" | "maxLabel",
  text: string
): RatingSettings {
  const next = { ...range }
  if (text === "") delete next[key]
  else next[key] = text
  return next
}

/**
 * A rating question's settings in the builder, with the same field a
 * respondent gets drawn underneath as a preview.
 */
export function RatingSettingsEditor({
  question,
  onChange,
}: {
  question: Question
  onChange: (rating: RatingSettings) => void
}) {
  const t = useAppT()
  const range = ratingRange(question)

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <div
          role="group"
          aria-label={t("builder.ratingStyle")}
          className="flex gap-1"
        >
          {(["stars", "scale"] as const).map((style) => (
            <button
              key={style}
              type="button"
              aria-pressed={range.style === style}
              onClick={() => {
                // Each style starts from its own default: a 0 start or end
                // labels mean nothing on stars.
                if (style !== range.style) {
                  onChange({
                    ...(style === "stars" ? DEFAULT_RATING : DEFAULT_SCALE),
                  })
                }
              }}
              className={cn(
                "rounded-md px-2.5 py-1 transition-colors duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100",
                range.style === style
                  ? "bg-foreground/[0.08] text-foreground"
                  : "hover:bg-foreground/[0.04]"
              )}
            >
              {style === "stars" ? t("builder.stars") : t("builder.numbers")}
            </button>
          ))}
        </div>
        {range.style === "stars" ? (
          <label className="flex items-center gap-2">
            {t("builder.stars")}
            <select
              aria-label={t("builder.numberOfStars")}
              value={range.max}
              onChange={(event) =>
                onChange({
                  style: "stars",
                  min: 1,
                  max: Number(event.target.value),
                })
              }
              className={SMALL_SELECT_CLASSES}
            >
              {STAR_COUNTS.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="flex items-center gap-2">
            {t("builder.from")}
            <select
              aria-label={t("builder.scaleStart")}
              value={range.min}
              onChange={(event) =>
                onChange({ ...range, min: event.target.value === "0" ? 0 : 1 })
              }
              className={SMALL_SELECT_CLASSES}
            >
              <option value={0}>0</option>
              <option value={1}>1</option>
            </select>
            {t("builder.to")}
            <select
              aria-label={t("builder.scaleEnd")}
              value={range.max}
              onChange={(event) =>
                onChange({ ...range, max: Number(event.target.value) })
              }
              className={SMALL_SELECT_CLASSES}
            >
              {SCALE_ENDS.map((end) => (
                <option key={end} value={end}>
                  {end}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>

      {range.style === "scale" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            dir={autoDir(range.minLabel)}
            aria-label={t("builder.lowLabel")}
            placeholder={t("builder.endLabel", { value: range.min })}
            value={range.minLabel ?? ""}
            onChange={(event) =>
              onChange(withLabel(range, "minLabel", event.target.value))
            }
            className={LABEL_INPUT_CLASSES}
          />
          <input
            dir={autoDir(range.maxLabel)}
            aria-label={t("builder.highLabel")}
            placeholder={t("builder.endLabel", { value: range.max })}
            value={range.maxLabel ?? ""}
            onChange={(event) =>
              onChange(withLabel(range, "maxLabel", event.target.value))
            }
            className={LABEL_INPUT_CLASSES}
          />
        </div>
      )}

      <RatingField
        question={{ ...question, rating: range }}
        value={undefined}
        preview
      />
    </div>
  )
}
