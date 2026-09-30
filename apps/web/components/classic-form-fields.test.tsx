import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/form-i18n", async () => vi.importActual("../lib/form-i18n"))
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}))
vi.mock("@/components/form-header-card", () => ({
  FormHeaderCard: ({
    title,
    headerImageUrl,
  }: {
    title: string
    headerImageUrl?: string | null
  }) => <h1 data-header-image={headerImageUrl ?? "none"}>{title}</h1>,
}))
vi.mock("@/components/form-question-card", () => ({
  FormQuestionCard: ({
    question,
  }: {
    question: { id: string; label: string }
  }) => (
    <div data-testid="question-card" id={question.id}>
      {question.label}
    </div>
  ),
}))
vi.mock("@/lib/form-pagination", async () => {
  return await vi.importActual("../lib/form-pagination")
})
vi.mock("@/lib/form-answers", async () => {
  return await vi.importActual("../lib/form-answers")
})
vi.mock("@/hooks/use-form-steps", async () => {
  return await vi.importActual("../hooks/use-form-steps")
})

import { ClassicFormFields } from "./classic-form-fields"
import { FormLanguageContext } from "../lib/form-i18n"
import type { Question } from "@krypta/crypto"

function question(id: string, pageBreakBefore?: boolean): Question {
  return { id, type: "short_text", label: id, pageBreakBefore }
}

const noopSharedProps = {
  onAnswerChange: () => undefined,
  onToggleCheckbox: () => undefined,
  onFileSelect: () => undefined,
  uploadingIds: new Set<string>(),
  uploadErrors: {},
  missingRequired: () => false,
  submitting: false,
  submitError: null,
  onSubmit: () => undefined,
}

describe("ClassicFormFields", () => {
  /*
   * The header image is resolved by the page and handed down, so the only way
   * it reaches the card is by being threaded through here. That thread was
   * missed once and the image rendered nowhere, which no type error catches
   * because the prop is optional everywhere it passes through.
   */
  it("passes the header image through to the header card", () => {
    const markup = renderToStaticMarkup(
      <ClassicFormFields
        title="A form"
        questions={[question("a")]}
        answers={{}}
        headerImageUrl="blob:resolved-header"
        {...noopSharedProps}
      />
    )
    expect(markup).toContain('data-header-image="blob:resolved-header"')
  })

  it("tells the card there is no header image when none was resolved", () => {
    const markup = renderToStaticMarkup(
      <ClassicFormFields
        title="A form"
        questions={[question("a")]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toContain('data-header-image="none"')
  })
  it("renders every question on one page and labels the button Submit when there are no breaks", () => {
    const markup = renderToStaticMarkup(
      <ClassicFormFields
        title="A form"
        questions={[question("a"), question("b"), question("c")]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toContain('id="a"')
    expect(markup).toContain('id="b"')
    expect(markup).toContain('id="c"')
    expect(markup).toContain("Submit")
    expect(markup).not.toContain("Page 1 of")
  })

  it("shows only the first page's questions and a Next button when there is a break", () => {
    const markup = renderToStaticMarkup(
      <ClassicFormFields
        title="A form"
        questions={[question("a"), question("b", true), question("c")]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toContain('id="a"')
    expect(markup).not.toContain('id="b"')
    expect(markup).not.toContain('id="c"')
    expect(markup).toContain("Page 1 of 2")
    expect(markup).toContain("Next")
  })

  it("does not leak a later page's section title onto the first page", () => {
    const markup = renderToStaticMarkup(
      <ClassicFormFields
        title="A form"
        questions={[
          question("a"),
          { ...question("b", true), sectionTitle: "Part two" },
        ]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).not.toContain("Part two")
  })

  it("explains why Next is disabled when a required question is unanswered", () => {
    const markup = renderToStaticMarkup(
      <ClassicFormFields
        title="A form"
        questions={[question("a")]}
        answers={{}}
        {...noopSharedProps}
        missingRequired={() => true}
      />
    )
    expect(markup).toContain("Answer every required question to continue.")
  })

  it("explains why Next is disabled while a file is still uploading", () => {
    const markup = renderToStaticMarkup(
      <ClassicFormFields
        title="A form"
        questions={[{ id: "a", type: "file_upload", label: "Attach" }]}
        answers={{}}
        {...noopSharedProps}
        uploadingIds={new Set(["a"])}
      />
    )
    expect(markup).toContain("Waiting for the file upload to finish.")
  })

  it("labels its buttons in Arabic for an Arabic form", () => {
    const markup = renderToStaticMarkup(
      <FormLanguageContext value="ar">
        <ClassicFormFields title="A form" questions={[question("a")]} answers={{}} {...noopSharedProps} />
      </FormLanguageContext>
    )
    expect(markup).toContain("إرسال")
    expect(markup).not.toContain(">Submit<")
  })

  it("lets a section title set its own direction", () => {
    const markup = renderToStaticMarkup(
      <ClassicFormFields
        title="A form"
        questions={[{ ...question("a"), pageBreakBefore: true, sectionTitle: "القسم الأول" }]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toMatch(/<h2[^>]*dir="auto"[^>]*>القسم الأول/)
  })
})
