"use client"

import type { Question } from "@krypta/crypto"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatAnswer, type AnswerValue } from "@/lib/form-answers"
import { entryFor, type AnswerKey } from "@/lib/quiz"
import {
  automaticGrade,
  scoreResponse,
  type QuestionScoreStatus,
} from "@/lib/quiz-score"
import { useAppT, translateKey } from "@/lib/app-i18n"
import { cn } from "@/lib/utils"

const STATUS_KEYS: Record<
  Exclude<QuestionScoreStatus, "not_scored">,
  string
> = {
  correct: "quiz.correct",
  incorrect: "quiz.incorrect",
  needs_grading: "quiz.needsGrading",
}

interface GradeResponseDialogProps {
  onClose: () => void
  position: number
  questions: Question[]
  answerKey: AnswerKey
  answers: Record<string, AnswerValue>
  marks: Record<string, boolean> | undefined
  /** False for Viewers: they see the same dialog without the controls. */
  canGrade: boolean
  onMark: (questionId: string, mark: boolean | null) => void
  onNext: (() => void) | null
  /**
   * The Responses tab shows the same notice, but behind this modal a grader
   * never sees it there: it has to repeat here or a conflict can go
   * unnoticed for as long as the dialog stays open.
   */
  conflict: boolean
  onDismissConflict: () => void
}

export function GradeResponseDialog({
  onClose,
  position,
  questions,
  answerKey,
  answers,
  marks,
  canGrade,
  onMark,
  onNext,
  conflict,
  onDismissConflict,
}: GradeResponseDialogProps) {
  const t = useAppT()
  const score = scoreResponse(questions, answerKey, answers, marks)
  const scored = questions.filter(
    (question) => score.questions[question.id]?.status !== "not_scored"
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("quiz.response", { position })}</DialogTitle>
          <DialogDescription className="tabular-nums">
            {score.earned} / {score.possible}
            {score.pending > 0 &&
              t("quiz.leftToGrade", { count: score.pending })}
          </DialogDescription>
        </DialogHeader>
        {conflict && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
            <p>{t("formPage.gradeConflict")}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDismissConflict}
            >
              {t("formPage.dismiss")}
            </Button>
          </div>
        )}
        <ol className="flex flex-col gap-3">
          {scored.map((question) => {
            const result = score.questions[question.id]
            const status = result.status as Exclude<
              QuestionScoreStatus,
              "not_scored"
            >
            const entry = entryFor(answerKey, question.id)
            const marked =
              marks !== undefined && Object.hasOwn(marks, question.id)
                ? marks[question.id]
                : undefined
            const automatic =
              entry === undefined
                ? null
                : automaticGrade(question, entry, answers[question.id])
            return (
              <li
                key={question.id}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium">
                    {question.label || t("quiz.untitled")}
                  </p>
                  <span
                    className={cn(
                      "shrink-0 text-xs tabular-nums",
                      status === "correct" && "text-primary",
                      status === "incorrect" && "text-destructive",
                      status === "needs_grading" && "text-muted-foreground"
                    )}
                  >
                    {translateKey(t, STATUS_KEYS[status])} ({result.earned}/
                    {result.points})
                  </span>
                </div>
                <p className="mt-1 text-sm break-words text-muted-foreground">
                  {formatAnswer(answers[question.id]) || t("quiz.noAnswer")}
                </p>
                {status === "incorrect" && entry?.correct && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("quiz.correctIs", {
                      answers: entry.correct.join(t("common.listSeparator")),
                    })}
                  </p>
                )}
                {canGrade && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={marked === true ? "default" : "outline"}
                      aria-pressed={marked === true}
                      onClick={() => onMark(question.id, true)}
                    >
                      {t("quiz.correct")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={marked === false ? "default" : "outline"}
                      aria-pressed={marked === false}
                      onClick={() => onMark(question.id, false)}
                    >
                      {t("quiz.incorrect")}
                    </Button>
                    {marked !== undefined && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onMark(question.id, null)}
                      >
                        {automatic === null
                          ? t("quiz.clearGrade")
                          : t("quiz.useAutomatic")}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
        <DialogFooter>
          {onNext && (
            <Button type="button" variant="outline" size="sm" onClick={onNext}>
              {t("quiz.next")}
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>
            {t("quiz.done")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
