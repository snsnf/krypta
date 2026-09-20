"use client"

import type { Question } from "@krypta/crypto"
import type { AnswerValue } from "@/lib/form-answers"
import type { AnswerKey } from "@/lib/quiz"
import { scoreResponse } from "@/lib/quiz-score"

export function ScoreCell({
  position,
  questions,
  answerKey,
  answers,
  marks,
  onOpen,
}: {
  position: number
  questions: Question[]
  answerKey: AnswerKey
  answers: Record<string, AnswerValue>
  marks: Record<string, boolean> | undefined
  onOpen: () => void
}) {
  const score = scoreResponse(questions, answerKey, answers, marks)
  return (
    <td className="border-b border-border px-3 py-2.5 whitespace-nowrap">
      <button
        type="button"
        aria-label={`Score for response ${position}`}
        onClick={onOpen}
        className="text-primary tabular-nums underline underline-offset-4 transition-opacity duration-150 ease-out hover:opacity-70"
      >
        {score.earned} / {score.possible}
      </button>
      {score.pending > 0 && (
        <span className="ml-2 text-xs text-muted-foreground">
          {score.pending} to grade
        </span>
      )}
    </td>
  )
}
