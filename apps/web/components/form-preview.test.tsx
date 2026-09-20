import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/question-options", async () =>
  vi.importActual("../lib/question-options")
)
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/form-theme-surface", () => ({
  FormThemeSurface: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}))
vi.mock("@/components/form-header-card", () => ({
  FormHeaderCard: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
vi.mock("@/components/form-question-card", () => ({
  FormQuestionCard: ({ question }: { question: { label: string } }) => (
    <div>{question.label}</div>
  ),
}))
vi.mock("@/components/form-question-field", () => ({
  FormQuestionField: () => null,
}))
vi.mock("@/components/theme-toggle", () => ({
  revealColorChange: (_x: number, _y: number, apply: () => void) => apply(),
}))
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
vi.mock("@/lib/form-pagination", async () => {
  return await vi.importActual("../lib/form-pagination")
})
vi.mock("@/lib/form-answers", async () => {
  return await vi.importActual("../lib/form-answers")
})
vi.mock("@/hooks/use-form-steps", async () => {
  return await vi.importActual("../hooks/use-form-steps")
})
vi.mock("@/components/classic-form-fields", async () => {
  return await vi.importActual("./classic-form-fields")
})
vi.mock("@/components/focus-form-renderer", async () => {
  return await vi.importActual("./focus-form-renderer")
})
vi.mock("@/lib/form-visibility", async () => {
  return await vi.importActual("../lib/form-visibility")
})

import { FormPreview } from "./form-preview"
import { DEFAULT_FORM_THEME } from "../lib/form-theme"
import type { Question } from "@krypta/crypto"

const questions: Question[] = [{ id: "a", type: "short_text", label: "Name" }]

describe("FormPreview", () => {
  it("renders through ClassicFormFields for a classic-layout form", () => {
    const markup = renderToStaticMarkup(
      <FormPreview
        open
        onOpenChange={() => undefined}
        title="A form"
        questions={questions}
        theme={DEFAULT_FORM_THEME}
      />
    )
    expect(markup).toContain("Name")
    expect(markup).toContain("Submit")
  })

  it("renders through FocusFormRenderer for a focus-layout form", () => {
    const markup = renderToStaticMarkup(
      <FormPreview
        open
        onOpenChange={() => undefined}
        title="A form"
        questions={questions}
        theme={{ ...DEFAULT_FORM_THEME, layout: "focus" }}
      />
    )
    // The Enter keycap is rendered only by the focus renderer, so its presence
    // is what proves the layout choice routed here rather than to classic.
    // "press" and "Enter" are separate nodes now, so match the key's own label.
    expect(markup).toContain("Enter \u21b5")
  })
})
