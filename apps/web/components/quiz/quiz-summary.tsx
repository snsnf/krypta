"use client"

import type { Question } from "@krypta/crypto"
import type { AnswerValue } from "@/lib/form-answers"
import type { AnswerKey, Grades } from "@/lib/quiz"
import { SCORE_BUCKETS, summarizeQuiz } from "@/lib/quiz-score"

function bucketLabel(index: number): string {
  const size = 100 / SCORE_BUCKETS
  const low = index * size
  const high = index === SCORE_BUCKETS - 1 ? 100 : low + size - 1
  return `${low} to ${high}%`
}

export function QuizSummary({
  questions,
  answerKey,
  responses,
  grades,
}: {
  questions: Question[]
  answerKey: AnswerKey
  responses: { id: string; answers: Record<string, AnswerValue> }[]
  grades: Grades
}) {
  const summary = summarizeQuiz(questions, answerKey, responses, grades)
  const tallest = Math.max(1, ...summary.histogram)
  const labels = new Map(questions.map((q) => [q.id, q.label]))

  return (
    <div
      data-testid="quiz-summary"
      className="mb-4 rounded-lg border border-border bg-card p-4"
    >
      <p className="text-sm font-medium">Scores</p>
      {summary.graded === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No response is fully graded yet.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-3 gap-3 text-sm tabular-nums">
          {(
            [
              ["Average", summary.average],
              ["Highest", summary.highest],
              ["Lowest", summary.lowest],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-medium">
                {value} / {summary.possible}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {summary.pending > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {summary.pending} response{summary.pending === 1 ? "" : "s"} still
          need{summary.pending === 1 ? "s" : ""} grading.
        </p>
      )}
      {summary.graded > 0 && (
        <div className="mt-4 flex flex-col gap-1.5">
          {summary.histogram.map((count, index) => (
            <div key={index} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 text-muted-foreground tabular-nums">
                {bucketLabel(index)}
              </span>
              <div className="h-2 flex-1 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-[var(--chart-1)]"
                  style={{ width: `${(count / tallest) * 100}%` }}
                />
              </div>
              <span className="w-6 text-right tabular-nums">{count}</span>
            </div>
          ))}
        </div>
      )}
      {summary.perQuestion.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1 text-sm">
          {summary.perQuestion.map((row) => (
            <li key={row.questionId} className="flex justify-between gap-3">
              <span className="truncate">
                {labels.get(row.questionId) || "Untitled question"}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {row.graded === 0
                  ? "Not graded yet"
                  : `${Math.round((row.correct / row.graded) * 100)}% correct`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
