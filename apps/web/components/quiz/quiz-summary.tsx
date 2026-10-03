"use client"

import type { Question } from "@krypta/crypto"
import type { AnswerValue } from "@/lib/form-answers"
import type { AnswerKey, Grades } from "@/lib/quiz"
import { useAppT, type AppTranslator } from "@/lib/app-i18n"
import { SCORE_BUCKETS, summarizeQuiz } from "@/lib/quiz-score"

function bucketLabel(index: number, t: AppTranslator): string {
  const size = 100 / SCORE_BUCKETS
  const low = index * size
  const high = index === SCORE_BUCKETS - 1 ? 100 : low + size - 1
  return t("quiz.bucket", { low, high })
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
  const t = useAppT()
  const summary = summarizeQuiz(questions, answerKey, responses, grades)
  const tallest = Math.max(1, ...summary.histogram)
  const labels = new Map(questions.map((q) => [q.id, q.label]))

  return (
    <div
      data-testid="quiz-summary"
      className="mb-4 rounded-lg border border-border bg-card p-4"
    >
      <p className="text-sm font-medium">{t("quiz.scores")}</p>
      {summary.graded === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("quiz.noneGraded")}
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-3 gap-3 text-sm tabular-nums">
          {(
            [
              [t("quiz.average"), summary.average],
              [t("quiz.highest"), summary.highest],
              [t("quiz.lowest"), summary.lowest],
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
          {t("quiz.pending", { count: summary.pending })}
        </p>
      )}
      {summary.graded > 0 && (
        <div className="mt-4 flex flex-col gap-1.5">
          {summary.histogram.map((count, index) => (
            <div key={index} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 text-muted-foreground tabular-nums">
                {bucketLabel(index, t)}
              </span>
              <div className="h-2 flex-1 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-[var(--chart-1)]"
                  style={{ width: `${(count / tallest) * 100}%` }}
                />
              </div>
              <span className="w-6 text-end tabular-nums">{count}</span>
            </div>
          ))}
        </div>
      )}
      {summary.perQuestion.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1 text-sm">
          {summary.perQuestion.map((row) => (
            <li key={row.questionId} className="flex justify-between gap-3">
              <span className="truncate">
                {labels.get(row.questionId) || t("quiz.untitled")}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {row.graded === 0
                  ? t("quiz.notGraded")
                  : t("quiz.percentCorrect", {
                      percent: Math.round((row.correct / row.graded) * 100),
                    })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
