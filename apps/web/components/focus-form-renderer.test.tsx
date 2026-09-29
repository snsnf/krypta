import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/question-options", async () =>
  vi.importActual("../lib/question-options")
)
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}))
vi.mock("@/components/form-question-field", () => ({
  FormQuestionField: ({ question }: { question: { id: string } }) => (
    <input id={question.id} data-testid="stub-field" />
  ),
}))
vi.mock("@/lib/form-answers", async () => {
  return await vi.importActual("../lib/form-answers")
})
vi.mock("@/hooks/use-form-steps", async () => {
  return await vi.importActual("../hooks/use-form-steps")
})
vi.mock("@/components/bezel", () => ({
  Bezel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("motion/react", () => {
  // Node-only vitest has no client React context for Motion's hooks, and these
  // tests assert rendered content rather than motion. Render children plainly
  // and drop the animation props so they never reach the DOM.
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  )
  return {
    motion: new Proxy({}, { get: () => Passthrough }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => (
      <>{children}</>
    ),
    useReducedMotion: () => false,
  }
})

import { FocusFormRenderer } from "./focus-form-renderer"
import type { Question } from "@krypta/crypto"

function question(id: string, label: string): Question {
  return { id, type: "short_text", label }
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

describe("FocusFormRenderer", () => {
  it("contains the field's top margin inside the measured card when the label is empty", () => {
    // An empty label is 0px tall, so the field's mt-6 would collapse through it
    // and out of the measured element, and the card would be cut 24px short.
    // flow-root stops the collapse; the Node-only vitest cannot measure the
    // layout itself, so this pins the class that does.
    const markup = renderToStaticMarkup(
      <FocusFormRenderer
        title="RSVP"
        questions={[question("a", "")]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toMatch(/<div class="[^"]*\bflow-root\b[^"]*"><div/)
  })
  it("shows only the first question and its progress on initial render", () => {
    const markup = renderToStaticMarkup(
      <FocusFormRenderer
        title="RSVP"
        questions={[question("a", "First?"), question("b", "Second?")]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toContain("First?")
    expect(markup).not.toContain("Second?")
    expect(markup).toContain('id="a"')
    expect(markup).not.toContain('id="b"')
    expect(markup).toContain("Next")
  })

  it("labels the button Submit when there is only one question", () => {
    const markup = renderToStaticMarkup(
      <FocusFormRenderer
        title="RSVP"
        questions={[question("a", "Only question?")]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toContain("Submit")
  })

  it("uses the form's own accent color, not a hardcoded brand color", () => {
    const markup = renderToStaticMarkup(
      <FocusFormRenderer
        title="RSVP"
        questions={[question("a", "First?")]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toContain("form-theme-accent-bg")
    expect(markup).not.toContain("var(--brand)")
  })

  it("explains why the button is disabled when the question is required and unanswered", () => {
    const markup = renderToStaticMarkup(
      <FocusFormRenderer
        title="RSVP"
        questions={[{ ...question("a", "First?"), required: true }]}
        answers={{}}
        {...noopSharedProps}
        missingRequired={() => true}
      />
    )
    expect(markup).toContain("This question is required.")
  })

  it("explains why the button is disabled while a file is still uploading", () => {
    const markup = renderToStaticMarkup(
      <FocusFormRenderer
        title="RSVP"
        questions={[{ id: "a", type: "file_upload", label: "Attach" }]}
        answers={{}}
        {...noopSharedProps}
        uploadingIds={new Set(["a"])}
      />
    )
    expect(markup).toContain("Waiting for the file upload to finish.")
  })

  it("renders an empty-state message instead of crashing when there are no questions", () => {
    const markup = renderToStaticMarkup(
      <FocusFormRenderer
        title="RSVP"
        questions={[]}
        answers={{}}
        {...noopSharedProps}
      />
    )
    expect(markup).toContain("This form has no questions yet.")
  })
})
