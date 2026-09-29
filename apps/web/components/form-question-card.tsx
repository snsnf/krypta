"use client"

import type { Question } from "@krypta/crypto"
import { FormQuestionField } from "@/components/form-question-field"
import type { AnswerValue } from "@/hooks/use-public-form-answers"

interface FormQuestionCardProps {
  question: Question
  value: AnswerValue | undefined
  onAnswerChange: (value: AnswerValue) => void
  onToggleCheckbox: (option: string) => void
  onFileSelect: (file: File | undefined) => void
  uploading: boolean
  uploadError: string | undefined
}

export function FormQuestionCard({
  question,
  value,
  onAnswerChange,
  onToggleCheckbox,
  onFileSelect,
  uploading,
  uploadError,
}: FormQuestionCardProps) {
  /*
   * Classic stacks every question on one page, so a lifted, shadowed card per
   * question means a page of competing focal points and no hierarchy. One
   * hairline border is the only separator here: the shadow and the
   * ring-on-top-of-a-border that Focus uses are both dropped, and the padding
   * is sized for a card in a list rather than a card that owns the screen.
   * Focus keeps the lift, because there the card really is the focal point.
   */
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <label
        htmlFor={question.id}
        className="form-theme-question mb-2.5 block font-medium"
      >
        {question.label}
        {question.required && (
          <span className="form-theme-accent-text ms-0.5">*</span>
        )}
      </label>
      <FormQuestionField
        question={question}
        density="compact"
        value={value}
        onChange={onAnswerChange}
        onToggleCheckbox={onToggleCheckbox}
        onFileSelect={onFileSelect}
        uploading={uploading}
        uploadError={uploadError}
      />
    </section>
  )
}
