import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/form-language", async () => vi.importActual("../lib/form-language"))
vi.mock("@/lib/app-format", async () => vi.importActual("../lib/app-format"))
vi.mock("@/lib/form-i18n", async () => vi.importActual("../lib/form-i18n"))
vi.mock("@/lib/text-direction", async () => vi.importActual("../lib/text-direction"))
vi.mock("@/lib/question-options", async () =>
  vi.importActual("../lib/question-options")
)
vi.mock("@/lib/form-other", async () => vi.importActual("../lib/form-other"))
vi.mock("@/components/rating-field", async () => vi.importActual("./rating-field"))
vi.mock("@/lib/question-rating", async () =>
  vi.importActual("../lib/question-rating")
)
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
import { FormLanguageContext } from "../lib/form-i18n"
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
  it("renders five stars as a named radio group with one radio per star", () => {
    const question: Question = {
      id: "r",
      type: "rating",
      label: "How was it?",
      rating: { style: "stars", min: 1, max: 5 },
    }
    const markup = renderToStaticMarkup(
      <FormQuestionField {...baseProps(question)} value="4" />
    )
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain('aria-label="How was it?"')
    expect(markup.match(/type="radio"/g)).toHaveLength(5)
    expect(markup).toContain('aria-label="4 of 5 stars"')
    // Attribute order is React's to choose, so find the one checked input.
    const checked = markup.match(/<input[^>]*checked=""[^>]*>/g) ?? []
    expect(checked).toHaveLength(1)
    expect(checked[0]).toContain('value="4"')
  })

  it("renders a 0 to 10 scale with its end labels", () => {
    const question: Question = {
      id: "s",
      type: "rating",
      label: "Recommend us?",
      rating: {
        style: "scale",
        min: 0,
        max: 10,
        minLabel: "Not likely",
        maxLabel: "Very likely",
      },
    }
    const markup = renderToStaticMarkup(
      <FormQuestionField {...baseProps(question)} />
    )
    expect(markup.match(/type="radio"/g)).toHaveLength(11)
    // The end labels are the scale's meaning, so the end radios say them.
    expect(markup).toContain('aria-label="0, Not likely, on a scale of 0 to 10"')
    expect(markup).toContain('aria-label="5, on a scale of 0 to 10"')
    expect(markup).toContain(
      'aria-label="10, Very likely, on a scale of 0 to 10"'
    )
    expect(markup).toContain("Not likely")
    expect(markup).toContain("Very likely")
    // Not a bare "checked": the scale boxes carry has-[:checked] classes.
    expect(markup).not.toMatch(/checked=""/)
  })

  it("marks the first radio required on a required rating", () => {
    const question: Question = {
      id: "r",
      type: "rating",
      label: "How was it?",
      required: true,
      rating: { style: "stars", min: 1, max: 3 },
    }
    const markup = renderToStaticMarkup(
      <FormQuestionField {...baseProps(question)} />
    )
    expect(markup).toContain('required=""')
  })

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
    expect(markup).toContain("2.0 KB")
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

  it("speaks the form's language for an Arabic form", () => {
    const arabic = (question: Question) =>
      renderToStaticMarkup(
        <FormLanguageContext value="ar">
          <FormQuestionField {...baseProps(question)} />
        </FormLanguageContext>
      )
    const text = arabic({ id: "t", type: "short_text", label: "Name" })
    expect(text).toContain('placeholder="إجابتك"')
    expect(text).not.toContain("Your answer")
    const dropdown = arabic({ id: "d", type: "dropdown", label: "Pick", options: ["x"] })
    expect(dropdown).toContain("اختر خيارًا")
    expect(dropdown).not.toContain("Select an option")
  })

  it("numbers Focus option badges for an Arabic form, where letters cannot be typed", () => {
    const markup = renderToStaticMarkup(
      <FormLanguageContext value="ar">
        <FormQuestionField
          {...baseProps({ id: "m", type: "multiple_choice", label: "Pick", options: ["x", "y"] })}
        />
      </FormLanguageContext>
    )
    expect(markup).toMatch(/>1<\/span>/)
    expect(markup).toMatch(/>2<\/span>/)
    expect(markup).not.toMatch(/>A<\/span>/)
    expect(optionShortcutIndex("2", 2, true)).toBe(1)
    expect(optionShortcutIndex("b", 2, true)).toBe(-1)
    expect(optionShortcutIndex("b", 2, false)).toBe(1)
  })

  it("leaves no English in an Arabic file upload, including its errors", () => {
    const arabic = (extra: Record<string, unknown>) =>
      renderToStaticMarkup(
        <FormLanguageContext value="ar">
          <FormQuestionField
            {...baseProps({ id: "f", type: "file_upload", label: "CV" })}
            {...extra}
          />
        </FormLanguageContext>
      )
    const empty = arabic({ uploadError: "fileTooLarge" })
    expect(empty).not.toContain("drag and drop")
    expect(empty).toContain("أو اسحبه وأفلته هنا")
    expect(empty).toContain("الملف كبير جدًا")
    expect(empty).not.toContain("File is too large")
    const done = arabic({
      value: { attachmentId: "a1", filename: "cv.pdf", mimeType: "application/pdf", size: 100 },
    })
    expect(done).not.toContain("Choose a different file")
    expect(done).toContain("اختر ملفًا آخر")
  })

  it("accepts Arabic-Indic and Persian digits as number shortcuts", () => {
    expect(optionShortcutIndex("\u0661", 3, true)).toBe(0)
    expect(optionShortcutIndex("\u0663", 3, true)).toBe(2)
    expect(optionShortcutIndex("\u06F2", 3, true)).toBe(1)
    expect(optionShortcutIndex("\u0669", 3, true)).toBe(-1)
  })

  it("lets a typed answer set its own direction, but an empty box follows the form", () => {
    // HTML resolves dir="auto" on an empty input to ltr, not to the parent, so
    // an empty box in an Arabic form must carry no dir at all.
    for (const type of ["short_text", "long_text", "email"] as const) {
      const empty = renderToStaticMarkup(
        <FormQuestionField {...baseProps({ id: "x", type, label: "x" })} />
      )
      expect(empty).not.toContain("dir=")
      const typed = renderToStaticMarkup(
        <FormQuestionField {...baseProps({ id: "x", type, label: "x" })} value="أحمد" />
      )
      expect(typed).toContain('dir="auto"')
    }
    // Numbers and dates hold no letters, so auto would force them ltr.
    for (const type of ["number", "date"] as const) {
      const typed = renderToStaticMarkup(
        <FormQuestionField {...baseProps({ id: "x", type, label: "x" })} value="12" />
      )
      expect(typed).not.toContain('dir="auto"')
    }
  })

  it("lets each option's text set its own direction", () => {
    const markup = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({ id: "m", type: "multiple_choice", label: "x", options: ["نعم؟"] })}
      />
    )
    expect(markup).toContain('<span dir="auto">نعم؟</span>')
    const checks = renderToStaticMarkup(
      <FormQuestionField
        {...baseProps({ id: "c", type: "checkboxes", label: "x", options: ["لا؟"] })}
      />
    )
    expect(checks).toContain('<span dir="auto">لا؟</span>')
  })

  it("shows no badge past nine in an Arabic form, where there is no key to press", () => {
    const options = Array.from({ length: 10 }, (_, i) => `o${i + 1}`)
    const markup = renderToStaticMarkup(
      <FormLanguageContext value="ar">
        <FormQuestionField {...baseProps({ id: "m", type: "multiple_choice", label: "x", options })} />
      </FormLanguageContext>
    )
    expect(markup).toMatch(/>9<\/span>/)
    expect(markup).not.toMatch(/>10<\/span>/)
  })
})
