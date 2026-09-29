import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/question-options", async () =>
  vi.importActual("../lib/question-options")
)
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (props: { checked?: boolean }) => (
    <input type="checkbox" readOnly checked={props.checked ?? false} />
  ),
}))
vi.mock("@/lib/form-other", async () => vi.importActual("../lib/form-other"))
vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}))
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock("@/components/ui/switch", () => ({
  Switch: (props: Record<string, unknown>) => <button {...props} />,
}))
vi.mock("@/components/form-preview", () => ({ FormPreview: () => null }))
vi.mock("@/components/theme-toggle", () => ({
  ColorModeSwitch: () => null,
  FORM_COLOR_MODE_LABELS: { light: "Light", system: "System", dark: "Dark" },
  revealColorChange: (_x: number, _y: number, apply: () => void) => apply(),
}))
vi.mock("@/hooks/use-prefers-dark", () => ({ usePrefersDark: () => false }))
vi.mock("@/components/form-header-card", () => ({
  FormHeaderCard: () => null,
}))
vi.mock("@/components/form-theme-surface", () => ({
  FormThemeSurface: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock("@/components/appearance/appearance-panel", () => ({
  AppearancePanel: () => null,
}))
vi.mock("@/components/quiz/answer-key-editor", () => ({
  AnswerKeyEditor: () => null,
}))
vi.mock("@/lib/quiz", async () => vi.importActual("../lib/quiz"))
// The real component: these tests assert on the warning text it renders,
// so a stub would make them assert nothing. Mocked only because this
// repo's vitest cannot resolve `@/` at runtime.
vi.mock("@/components/ui/alert", async () => vi.importActual("./ui/alert"))
vi.mock("@/lib/question-order", async () =>
  vi.importActual("../lib/question-order")
)
// Not a stub: this suite has no vite alias config, so every "@/" specifier
// needs a mock to resolve at all. The real hook is what runs.
vi.mock("@/hooks/use-question-reorder-drag", async () =>
  vi.importActual("../hooks/use-question-reorder-drag")
)
vi.mock("@/hooks/use-form-questions", async () =>
  vi.importActual("../hooks/use-form-questions")
)
vi.mock("@/lib/form-visibility", async () =>
  vi.importActual("../lib/form-visibility")
)
vi.mock("@/lib/question-rating", async () =>
  vi.importActual("../lib/question-rating")
)
vi.mock("@/components/rating-field", async () => vi.importActual("./rating-field"))
vi.mock("@/components/rating-settings", async () =>
  vi.importActual("./rating-settings")
)

import { FormBuilder } from "./form-builder"
import { DEFAULT_FORM_THEME } from "../lib/form-theme"
import type { Question } from "@krypta/crypto"

const questions: Question[] = [
  { id: "a", type: "short_text", label: "First" },
  { id: "b", type: "short_text", label: "Second" },
]

describe("FormBuilder section breaks", () => {
  it("shows an add-section-break affordance between questions in Classic layout", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={questions}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain("Add section break")
  })

  it("shows a remove-section-break control once a break exists", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={[questions[0], { ...questions[1], pageBreakBefore: true }]}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain("Remove section break")
  })

  it("shows a section-title input once a break exists, prefilled with its saved value", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={[
          questions[0],
          { ...questions[1], pageBreakBefore: true, sectionTitle: "Part two" },
        ]}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain("Section title (optional)")
    expect(markup).toContain('value="Part two"')
  })

  it("hides the section-break affordance entirely in Focus layout", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={questions}
        onQuestionsChange={() => undefined}
        theme={{ ...DEFAULT_FORM_THEME, layout: "focus" }}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).not.toContain("section break")
  })
})

describe("FormBuilder conditions", () => {
  const choiceQuestions: Question[] = [
    {
      id: "a",
      type: "multiple_choice",
      label: "Do you have a pet?",
      options: ["Yes", "No"],
    },
    { id: "b", type: "short_text", label: "Pet name" },
  ]

  it("offers no condition control on the first question", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={[choiceQuestions[0]]}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).not.toContain("Only show this if")
  })

  it("offers a condition control once an earlier choice-like question exists", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={choiceQuestions}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain("Only show this if")
  })

  it("renders the condition editor with the saved question, operator and value", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={[
          choiceQuestions[0],
          {
            ...choiceQuestions[1],
            condition: { questionId: "a", operator: "is", value: "Yes" },
          },
        ]}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain("Condition question")
    expect(markup).toContain("Condition operator")
    expect(markup).toContain("Condition value")
    expect(markup).toContain("Remove condition")
    expect(markup).not.toContain("no longer exists")
  })

  it("warns without deleting when the condition points at a removed question", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={[
          choiceQuestions[0],
          {
            ...choiceQuestions[1],
            condition: { questionId: "missing", operator: "is", value: "Yes" },
          },
        ]}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain("(unavailable question)")
    expect(markup).toContain(
      "This condition points at a question that is no longer a usable source"
    )
  })

  it("still warns when the condition's source is gone and no source remains", () => {
    // The warning used to be gated on there being an eligible source, so
    // deleting the only choice question hid the editor, the warning, and any
    // way to clear the condition, while the condition still shipped in the
    // encrypted schema.
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={[
          {
            ...choiceQuestions[1],
            condition: { questionId: "a", operator: "is", value: "Yes" },
          },
        ]}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain(
      "This condition points at a question that is no longer a usable source"
    )
    expect(markup).toContain("Remove condition")
    expect(markup).not.toContain("Condition question")
  })

  it("reports a source whose type is no longer choice-like as dangling", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={[
          { id: "a", type: "short_text", label: "Do you have a pet?" },
          {
            id: "c",
            type: "multiple_choice",
            label: "Colour",
            options: ["Red"],
          },
          {
            ...choiceQuestions[1],
            condition: { questionId: "a", operator: "is", value: "Yes" },
          },
        ]}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain("(unavailable question)")
    expect(markup).toContain(
      "This condition points at a question that is no longer a usable source"
    )
  })

  it("warns without deleting when the condition's value option was removed", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={[
          choiceQuestions[0],
          {
            ...choiceQuestions[1],
            condition: { questionId: "a", operator: "is", value: "Maybe" },
          },
        ]}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain("Maybe (removed)")
    expect(markup).toContain(
      "This condition points at an option that no longer exists, so the question stays hidden."
    )
  })
})

describe("FormBuilder question actions", () => {
  it("renders a reorder handle and a duplicate control per question", () => {
    const markup = renderToStaticMarkup(
      <FormBuilder
        eyebrowLabel="Editing form"
        title="A form"
        onTitleChange={() => undefined}
        questions={questions}
        onQuestionsChange={() => undefined}
        theme={DEFAULT_FORM_THEME}
        onThemeChange={() => undefined}
      />
    )
    expect(markup).toContain('aria-label="Reorder question 1"')
    expect(markup).toContain('aria-label="Reorder question 2"')
    expect(markup).toContain('aria-label="Duplicate question"')
  })
})

function renderBuilder(questionList: Question[]): string {
  return renderToStaticMarkup(
    <FormBuilder
      eyebrowLabel="Editing form"
      title="A form"
      onTitleChange={() => undefined}
      questions={questionList}
      onQuestionsChange={() => undefined}
      theme={DEFAULT_FORM_THEME}
      onThemeChange={() => undefined}
    />
  )
}

const fiveStars: Question = {
  id: "a",
  type: "rating",
  label: "How was it?",
  rating: { style: "stars", min: 1, max: 5 },
}

describe("FormBuilder rating questions", () => {
  it("offers Rating in the question type menu", () => {
    const markup = renderBuilder([{ id: "a", type: "short_text", label: "Name" }])
    expect(markup).toContain('<option value="rating">Rating</option>')
  })

  it("shows star settings and a preview for a rating question", () => {
    const markup = renderBuilder([fiveStars])
    expect(markup).toContain('aria-label="Number of stars"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup.match(/name="a-preview"/g)).toHaveLength(5)
  })

  it("shows scale range and end label inputs for a numbered scale", () => {
    const markup = renderBuilder([
      {
        id: "a",
        type: "rating",
        label: "Recommend?",
        rating: { style: "scale", min: 0, max: 10 },
      },
    ])
    expect(markup).toContain('aria-label="Scale start"')
    expect(markup).toContain('aria-label="Scale end"')
    expect(markup).toContain('aria-label="Low end label"')
    expect(markup).toContain('aria-label="High end label"')
  })

  it("offers at most and at least only when the source is a rating", () => {
    const markup = renderBuilder([
      fiveStars,
      {
        id: "b",
        type: "long_text",
        label: "What went wrong?",
        condition: { questionId: "a", operator: "at_most", value: "2" },
      },
    ])
    expect(markup).toContain(
      '<option value="at_most" selected="">is at most</option>'
    )
    expect(markup).toContain('<option value="at_least">is at least</option>')
    expect(markup).not.toContain("This condition never matches")
  })

  it("warns when a range bound is outside the source's range", () => {
    const markup = renderBuilder([
      fiveStars,
      {
        id: "b",
        type: "long_text",
        label: "Why?",
        condition: { questionId: "a", operator: "at_least", value: "8" },
      },
    ])
    expect(markup).toContain("This condition never matches")
  })

  it("warns about a range operator left on a choice source", () => {
    const markup = renderBuilder([
      { id: "a", type: "multiple_choice", label: "Pick", options: ["Yes", "No"] },
      {
        id: "b",
        type: "long_text",
        label: "Why?",
        condition: { questionId: "a", operator: "at_most", value: "Yes" },
      },
    ])
    // The evaluator fails open on this pairing, so the warning must say the
    // question always shows, not that it stays hidden.
    expect(markup).toContain("This condition is ignored")
    expect(markup).toContain("no longer a rating")
    expect(markup).not.toContain("This condition never matches")
    expect(markup).not.toContain('value="at_least"')
  })
})
