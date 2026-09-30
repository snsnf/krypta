import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/form-question-field", () => ({
  FormQuestionField: ({ question }: { question: { id: string } }) => (
    <input id={question.id} data-testid="stub-field" />
  ),
}))

import { FormQuestionCard } from "./form-question-card"
import type { Question } from "@krypta/crypto"

const noop = () => undefined

describe("FormQuestionCard", () => {
  it("shows the label and a required asterisk when required", () => {
    const question: Question = {
      id: "q1",
      type: "short_text",
      label: "Your name",
      required: true,
    }
    const markup = renderToStaticMarkup(
      <FormQuestionCard
        question={question}
        value={undefined}
        onAnswerChange={noop}
        onToggleCheckbox={noop}
        onFileSelect={noop}
        uploading={false}
        uploadError={undefined}
      />
    )
    expect(markup).toContain("Your name")
    expect(markup).toContain("form-theme-accent-text")
    expect(markup).toContain('id="q1"')
  })

  it("omits the asterisk when not required", () => {
    const question: Question = {
      id: "q2",
      type: "short_text",
      label: "Optional",
    }
    const markup = renderToStaticMarkup(
      <FormQuestionCard
        question={question}
        value={undefined}
        onAnswerChange={noop}
        onToggleCheckbox={noop}
        onFileSelect={noop}
        uploading={false}
        uploadError={undefined}
      />
    )
    expect(markup).not.toContain("form-theme-accent-text")
  })

  it("lets the label set its own direction, so an Arabic question reads right to left", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionCard
        question={{ id: "q9", type: "short_text", label: "ما اسمك؟" }}
        value={undefined}
        onAnswerChange={noop}
        onToggleCheckbox={noop}
        onFileSelect={noop}
        uploading={false}
        uploadError={undefined}
      />
    )
    expect(markup).toMatch(/<label[^>]*dir="auto"[^>]*>ما اسمك؟/)
  })
})
