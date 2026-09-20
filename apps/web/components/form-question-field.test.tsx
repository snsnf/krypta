import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/question-options", async () =>
  vi.importActual("../lib/question-options")
)
vi.mock("@/lib/form-other", async () => vi.importActual("../lib/form-other"))
vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}))
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    className,
  }: {
    checked?: boolean
    className?: string
  }) => (
    <span
      data-slot="checkbox"
      data-checked={checked ? "" : undefined}
      className={className}
    />
  ),
}))

import { FormQuestionField, optionShortcutIndex } from "./form-question-field"
import type { Question } from "@krypta/crypto"

const noop = () => undefined

function baseProps(question: Question) {
  return {
    question,
    value: undefined,
    onChange: noop,
    onToggleCheckbox: noop,
    onFileSelect: noop,
    uploading: false,
    uploadError: undefined,
  }
}

describe("FormQuestionField", () => {
  it("renders a required short_text as a required native input", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q1",
          type: "short_text",
          label: "Name",
          required: true,
        })}
      />
    )
    expect(markup).toContain('required=""')
  })

  it("renders a required long_text as a required textarea", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q1b",
          type: "long_text",
          label: "Bio",
          required: true,
        })}
      />
    )
    expect(markup).toContain("<textarea")
    expect(markup).toContain('required=""')
  })

  it("renders number/email/date as a native input of the matching type", () => {
    for (const type of ["number", "email", "date"] as const) {
      const markup = renderToStaticMarkup(
        <FormQuestionField
          {...baseProps({ id: `q-${type}`, type, label: type })}
        />
      )
      expect(markup).toContain(`type="${type}"`)
    }
  })

  it("renders dropdown as a select with a placeholder and every option", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q-dropdown",
          type: "dropdown",
          label: "Country",
          options: ["Lebanon", "France"],
        })}
      />
    )
    expect(markup).toContain("<select")
    expect(markup).toContain("Select an option")
    expect(markup).toContain("Lebanon")
    expect(markup).toContain("France")
  })

  it("renders every option for multiple_choice as a radio group", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q2",
          type: "multiple_choice",
          label: "Pick one",
          options: ["A", "B", "C"],
        })}
      />
    )
    expect(markup).toContain('role="radiogroup"')
    expect((markup.match(/type="radio"/g) ?? []).length).toBe(3)
  })

  it("renders checkboxes using the shared Checkbox component", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q3",
          type: "checkboxes",
          label: "Pick any",
          options: ["A", "B"],
        })}
      />
    )
    expect((markup.match(/data-slot="checkbox"/g) ?? []).length).toBe(2)
  })

  it("shows the uploaded filename for a completed file_upload answer", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({ id: "q4", type: "file_upload", label: "Attach" })}
        value={{
          attachmentId: "a1",
          filename: "resume.pdf",
          mimeType: "application/pdf",
          size: 100,
        }}
      />
    )
    expect(markup).toContain("resume.pdf")
  })

  it("disables the file input while uploading", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({ id: "q5", type: "file_upload", label: "Attach" })}
        uploading
      />
    )
    expect(markup).toContain('disabled=""')
    expect(markup).toContain("Encrypting and uploading")
  })

  it("shows the dropzone prompt and size limit when nothing is attached yet", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({ id: "q6", type: "file_upload", label: "Attach" })}
      />
    )
    expect(markup).toContain("Click to upload")
    expect(markup).toContain("drag and drop")
    expect(markup).toContain("Max 10MB")
  })

  it("keeps the uploaded filename announced for screen readers", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({ id: "q7", type: "file_upload", label: "Attach" })}
        value={{
          attachmentId: "a1",
          filename: "notes.pdf",
          mimeType: "application/pdf",
          size: 2048,
        }}
      />
    )
    expect(markup).toContain("Uploaded: ")
    expect(markup).toContain("notes.pdf")
    expect(markup).toContain("2 KB")
  })
})

describe("optionShortcutIndex", () => {
  it("maps a letter to its option, case insensitively", () => {
    expect(optionShortcutIndex("a", 3)).toBe(0)
    expect(optionShortcutIndex("C", 3)).toBe(2)
  })

  it("rejects a letter past the last option", () => {
    expect(optionShortcutIndex("D", 3)).toBe(-1)
  })

  // Beyond 26 the badges stop being letters, so the shortcut has to stop too
  // rather than matching a badge that reads "27".
  it("never reaches past the twenty-sixth option", () => {
    expect(optionShortcutIndex("Z", 40)).toBe(25)
    expect(optionShortcutIndex("[", 40)).toBe(-1)
  })

  it("ignores keys that are not single characters", () => {
    expect(optionShortcutIndex("Enter", 5)).toBe(-1)
    expect(optionShortcutIndex("1", 5)).toBe(-1)
  })
})

describe("option markers", () => {
  const options = (count: number) =>
    Array.from({ length: count }, (_, i) => `opt${i}`)

  it("numbers options past Z instead of walking off the alphabet", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q8",
          type: "multiple_choice",
          label: "Pick",
          options: options(28),
        })}
      />
    )
    expect(markup).toContain(">Z<")
    expect(markup).toContain(">27<")
    expect(markup).not.toContain(">[<")
  })

  it("shows a radio rather than a letter in compact density", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q9",
          type: "multiple_choice",
          label: "Pick",
          options: ["Yes", "No"],
        })}
        density="compact"
      />
    )
    expect(markup).not.toContain(">A<")
    expect(markup).toContain("rounded-full")
  })

  // Without aria-hidden the accessible name becomes "A Yes".
  it("hides the marker from assistive technology", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q10",
          type: "multiple_choice",
          label: "Pick",
          options: ["Yes"],
        })}
      />
    )
    expect(markup).toContain('aria-hidden="true"')
  })
})

describe("selected-option treatment", () => {
  const pick = (density?: "compact" | "comfortable") =>
    renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({
          id: "q11",
          type: "multiple_choice",
          label: "Pick",
          options: ["Yes", "No"],
        })}
        density={density}
      />
    )

  // Focus shows one question, so filling the chosen row is the answer. Classic
  // shows every question at once, where the same fill stacks into blocks of
  // solid colour, so only the control is coloured there.
  it("fills the row in Focus but not in Classic", () => {
    expect(pick("comfortable")).toContain(
      "has-[:checked]:bg-[var(--form-accent)]"
    )
    expect(pick("compact")).not.toContain(
      "has-[:checked]:bg-[var(--form-accent)]"
    )
  })

  it("still marks the Classic control as chosen", () => {
    expect(pick("compact")).toContain(
      "group-has-[:checked]/option:border-[var(--form-accent)]"
    )
  })
})
