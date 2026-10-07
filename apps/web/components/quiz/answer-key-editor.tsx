"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { CheckmarkCircle02Icon, CircleIcon } from "@hugeicons/core-free-icons"
import type { Question } from "@krypta/crypto"
import { Input } from "@/components/ui/input"
import { useAppT } from "@/lib/app-i18n"
import { cn } from "@/lib/utils"
import { MAX_QUIZ_POINTS, isChoiceType, type AnswerKeyEntry } from "@/lib/quiz"
import { distinctOptions } from "@/lib/question-options"
import { autoDir } from "@/lib/text-direction"

interface AnswerKeyEditorProps {
  question: Question
  entry: AnswerKeyEntry | undefined
  onChange: (entry: AnswerKeyEntry) => void
}

export function AnswerKeyEditor({
  question,
  entry,
  onChange,
}: AnswerKeyEditorProps) {
  const t = useAppT()
  const current: AnswerKeyEntry = entry ?? { points: 0 }

  // Marking an answer is what makes a question count, so one still at 0
  // points starts counting the moment it has an answer.
  function withAnswer(patch: Partial<AnswerKeyEntry>): AnswerKeyEntry {
    return {
      ...current,
      ...patch,
      points: current.points === 0 ? 1 : current.points,
    }
  }

  function toggleOption(option: string) {
    const chosen = current.correct ?? []
    if (question.type === "checkboxes") {
      const next = chosen.includes(option)
        ? chosen.filter((value) => value !== option)
        : [...chosen, option]
      onChange(
        next.length > 0
          ? withAnswer({ correct: next })
          : { ...current, correct: undefined }
      )
      return
    }
    onChange(
      chosen[0] === option
        ? { ...current, correct: undefined }
        : withAnswer({ correct: [option] })
    )
  }

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-dashed border-border p-3">
      {isChoiceType(question.type) ? (
        <div
          className="flex flex-col gap-1"
          role="group"
          aria-label={t("quiz.correctAnswer")}
        >
          {distinctOptions(question.options)
            .filter((option) => option.trim() !== "")
            .map((option) => {
              const on = (current.correct ?? []).includes(option)
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleOption(option)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-start text-sm transition-colors duration-150 ease-out hover:bg-muted",
                    on && "font-medium"
                  )}
                >
                  <HugeiconsIcon
                    icon={on ? CheckmarkCircle02Icon : CircleIcon}
                    size={16}
                    className={
                      on
                        ? "shrink-0 text-[var(--form-accent)]"
                        : "shrink-0 text-muted-foreground/50"
                    }
                  />
                  {option}
                </button>
              )
            })}
          {(question.options ?? []).every((option) => option.trim() === "") && (
            <p className="text-sm text-muted-foreground">
              {t("quiz.addOptions")}
            </p>
          )}
        </div>
      ) : question.type === "short_text" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t("quiz.accepted")}</span>
          {/* Raw lines are kept, empty ones included, so pressing Enter does
              not eat the new line; scoring ignores empty lines. */}
          <textarea
            dir={autoDir((current.accepted ?? []).join(""))}
            aria-label={t("quiz.acceptedLabel")}
            rows={3}
            value={(current.accepted ?? []).join("\n")}
            onChange={(event) =>
              onChange(withAnswer({ accepted: event.target.value.split("\n") }))
            }
            className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </label>
      ) : question.type === "number" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {t("quiz.correctValue")}
          </span>
          {/* Uncontrolled so typing "1." is not rewritten to "1" mid-entry. */}
          <Input
            aria-label={t("quiz.correctValue")}
            type="number"
            inputMode="decimal"
            defaultValue={current.value ?? ""}
            onChange={(event) => {
              const raw = event.target.value.trim()
              if (raw === "") {
                onChange({ ...current, value: undefined })
                return
              }
              const value = Number(raw)
              if (Number.isFinite(value)) onChange(withAnswer({ value }))
            }}
            className="max-w-40"
          />
        </label>
      ) : (
        <p className="text-sm text-muted-foreground">{t("quiz.byHand")}</p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("quiz.points")}</span>
        <Input
          aria-label={t("quiz.points")}
          type="number"
          min={0}
          max={MAX_QUIZ_POINTS}
          step={1}
          value={current.points}
          onChange={(event) => {
            const points = Math.round(Number(event.target.value))
            if (!Number.isFinite(points)) return
            onChange({
              ...current,
              points: Math.min(MAX_QUIZ_POINTS, Math.max(0, points)),
            })
          }}
          className="w-20"
        />
      </label>
    </div>
  )
}
