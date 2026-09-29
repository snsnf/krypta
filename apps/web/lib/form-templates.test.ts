import { describe, expect, it } from "vitest"
import { conditionValues, isRangeOperator } from "./form-visibility"
import { hasDuplicateOptions } from "./question-options"
import { FORM_TEMPLATES, instantiateTemplate } from "./form-templates"
import { DEFAULT_FORM_THEME } from "./form-theme"
import { DEFAULT_FORM_SETTINGS } from "./form-settings"

/*
 * Ciphertext is padded to a 1024-byte floor after a 5-byte header
 * (packages/crypto/src/pad.ts), and nearly every real schema sits under it.
 * A template published unedited has a fixed length, so one that spilled into
 * a larger bucket would be recognisable from the size of its ciphertext
 * alone, which is exactly the inference keeping the choice out of the URL
 * exists to prevent. Every unedited template must fit the floor.
 */
const SCHEMA_BUDGET_BYTES = 1024 - 5

function unEditedSchemaBytes(template: (typeof FORM_TEMPLATES)[number]): number {
  const start = instantiateTemplate(template)
  const schema = {
    questions: start.questions,
    theme: DEFAULT_FORM_THEME,
    settings: {
      ...DEFAULT_FORM_SETTINGS,
      confirmationMessage: start.confirmationMessage,
    },
    // formKeyCommitment is base64 of 32 bytes; 44 covers padded base64.
    publicKeyCommitment: "x".repeat(44),
  }
  return new TextEncoder().encode(JSON.stringify(schema)).length
}

describe("FORM_TEMPLATES", () => {
  it("ships the five templates in gallery order with unique ids", () => {
    expect(FORM_TEMPLATES.map((t) => t.id)).toEqual([
      "event-feedback",
      "rsvp",
      "job-application",
      "contact",
      "anonymous-report",
    ])
  })

  for (const template of FORM_TEMPLATES) {
    describe(template.name, () => {
      const { questions } = instantiateTemplate(template)

      it("gives every question a unique id", () => {
        expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length)
      })

      it("only points conditions at an earlier question and a value it offers", () => {
        questions.forEach((question, index) => {
          const condition = question.condition
          if (!condition) return
          const sourceIndex = questions.findIndex((q) => q.id === condition.questionId)
          expect(sourceIndex).toBeGreaterThanOrEqual(0)
          expect(sourceIndex).toBeLessThan(index)
          const source = questions[sourceIndex]
          expect(conditionValues(source)).toContain(condition.value)
          if (isRangeOperator(condition.operator)) expect(source.type).toBe("rating")
        })
      })

      it("has no question with two options of the same text", () => {
        for (const question of questions) {
          expect(hasDuplicateOptions(question.options)).toBe(false)
        }
      })

      it("fits the padding floor when published unedited", () => {
        expect(unEditedSchemaBytes(template)).toBeLessThanOrEqual(
          SCHEMA_BUDGET_BYTES
        )
      })

      it("carries a title and a confirmation message", () => {
        expect(template.title.trim()).not.toBe("")
        expect(template.confirmationMessage.trim()).not.toBe("")
      })
    })
  }
})

describe("instantiateTemplate", () => {
  const eventFeedback = FORM_TEMPLATES[0]

  it("rewrites a condition to the new id of the keyed question", () => {
    let n = 0
    const { questions } = instantiateTemplate(eventFeedback, () => `id-${++n}`)
    expect(questions.map((q) => q.id)).toEqual(["id-1", "id-2", "id-3", "id-4"])
    expect(questions[1].condition).toEqual({
      questionId: "id-1",
      operator: "at_most",
      value: "2",
    })
  })

  it("shares no ids between two forms made from one template", () => {
    const first = instantiateTemplate(eventFeedback).questions.map((q) => q.id)
    const second = instantiateTemplate(eventFeedback).questions.map((q) => q.id)
    expect(first.filter((id) => second.includes(id))).toEqual([])
  })

  it("leaves no template key on the questions it returns", () => {
    const { questions } = instantiateTemplate(eventFeedback)
    for (const question of questions) expect("key" in question).toBe(false)
  })
})
