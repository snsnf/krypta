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
