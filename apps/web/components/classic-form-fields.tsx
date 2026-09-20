"use client"

import type { Question } from "@krypta/crypto"
import { Button } from "@/components/ui/button"
import { FormHeaderCard } from "@/components/form-header-card"
import { FormQuestionCard } from "@/components/form-question-card"
import { useFormSteps } from "@/hooks/use-form-steps"
import type { AnswerValue } from "@/hooks/use-public-form-answers"

interface ClassicFormFieldsProps {
  title: string
  /** Resolved object URL for the header image, or null when there is none. */
  headerImageUrl?: string | null
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

export function ClassicFormFields({
  title,
  headerImageUrl = null,
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
}: ClassicFormFieldsProps) {
  /*
   * Position, resume, the end-of-form test and both advance gates come from
   * the shared step machine. A step here is a page, so Classic keeps what is
   * its own: a page of cards at once, the section title, the page counter, and
   * its own wording for why the button is disabled.
   */
  const {
    steps: pages,
    index: currentIndex,
    current: currentQuestions = [],
    isLast: isLastPage,
    blockedBy,
    back,
    submitStep,
  } = useFormSteps({
    questions,
    answers,
    layout: "classic",
    uploadingIds,
    missingRequired,
    onSubmit,
  })
  const stillUploading = blockedBy === "uploading"
  const pageInvalid = blockedBy !== null

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <FormHeaderCard title={title} headerImageUrl={headerImageUrl} />

      {pages.length > 1 && (
        <div>
          <p className="form-theme-text text-sm text-muted-foreground">
            Page {currentIndex + 1} of {pages.length}
          </p>
          <div className="mt-1 h-1 w-full rounded-full bg-border">
            <div
              className="form-theme-accent-bg h-full rounded-full transition-[width] duration-300 ease-out"
              style={{ width: `${((currentIndex + 1) / pages.length) * 100}%` }}
            />
          </div>
        </div>
      )}

      {currentQuestions[0]?.sectionTitle && (
        <h2 className="form-theme-header font-medium">
          {currentQuestions[0].sectionTitle}
        </h2>
      )}

      <form
        key={currentIndex}
        onSubmit={submitStep}
        className="animate-focus-question-in space-y-5"
      >
        {currentQuestions.map((q) => (
          <FormQuestionCard
            key={q.id}
            question={q}
            value={answers[q.id]}
            onAnswerChange={(value) => onAnswerChange(q.id, value)}
            onToggleCheckbox={(opt) => onToggleCheckbox(q.id, opt)}
            onFileSelect={(file) => onFileSelect(q.id, file)}
            uploading={uploadingIds.has(q.id)}
            uploadError={uploadErrors[q.id]}
          />
        ))}

        {submitError && (
          <p aria-live="polite" className="text-sm text-destructive">
            {submitError}
          </p>
        )}

        <div className="flex items-center gap-3">
          {currentIndex > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={back}
            >
              Back
            </Button>
          )}
          <Button
            type="submit"
            disabled={submitting || pageInvalid}
            className="form-theme-accent-bg form-theme-button form-theme-text active:scale-[0.97]"
          >
            {submitting && isLastPage
              ? "Submitting..."
              : isLastPage
                ? "Submit"
                : "Next"}
          </Button>
          {pageInvalid && !submitting && (
            <p className="form-theme-text text-sm text-muted-foreground">
              {stillUploading
                ? "Waiting for the file upload to finish."
                : "Answer every required question to continue."}
            </p>
          )}
        </div>
      </form>
    </div>
  )
}
