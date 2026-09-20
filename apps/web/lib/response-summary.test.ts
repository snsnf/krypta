import { describe, expect, it } from "vitest"
import type { Question } from "@krypta/crypto"

function choiceQuestion(): Question {
  return {
    id: "q1",
    type: "multiple_choice",
    label: "Pick one",
    options: ["A", "B", "C"],
  }
}

describe("summarizeResponses", () => {
  it("counts each option and keeps options nobody chose", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const [summary] = summarizeResponses(
      [choiceQuestion()],
      [{ q1: "A" }, { q1: "A" }, { q1: "B" }]
    )
    expect(summary.kind).toBe("choice")
    if (summary.kind !== "choice") throw new Error("expected a choice summary")
    expect(summary.options).toEqual([
      { value: "A", count: 2 },
      { value: "B", count: 1 },
      { value: "C", count: 0 },
    ])
    expect(summary.answered).toBe(3)
    expect(summary.skipped).toBe(0)
  })

  it("keeps an answer whose option was removed from the schema", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const [summary] = summarizeResponses(
      [choiceQuestion()],
      [{ q1: "A" }, { q1: "Deleted option" }]
    )
    if (summary.kind !== "choice") throw new Error("expected a choice summary")
    expect(summary.options).toEqual([
      { value: "A", count: 1 },
      { value: "B", count: 0 },
      { value: "C", count: 0 },
      { value: "Deleted option", count: 1 },
    ])
  })

  it("counts every checkbox selection, so counts can exceed the response total", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = {
      id: "q1",
      type: "checkboxes",
      label: "Pick any",
      options: ["A", "B"],
    }
    const [summary] = summarizeResponses(
      [question],
      [{ q1: ["A", "B"] }, { q1: ["A"] }]
    )
    if (summary.kind !== "choice") throw new Error("expected a choice summary")
    expect(summary.options).toEqual([
      { value: "A", count: 2 },
      { value: "B", count: 1 },
    ])
    expect(summary.answered).toBe(2)
    const total = summary.options.reduce((sum, o) => sum + o.count, 0)
    expect(total).toBeGreaterThan(summary.answered)
  })

  it("treats an empty value as skipped rather than answered", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = {
      id: "q1",
      type: "checkboxes",
      label: "Pick any",
      options: ["A"],
    }
    const [summary] = summarizeResponses(
      [question],
      [{ q1: ["A"] }, { q1: [] }, {}]
    )
    expect(summary.answered).toBe(1)
    expect(summary.skipped).toBe(2)
  })

  it("treats a whitespace-only text answer as skipped", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "short_text", label: "Name" }
    const [summary] = summarizeResponses([question], [{ q1: "Ada" }, { q1: "   " }])
    if (summary.kind !== "text") throw new Error("expected a text summary")
    expect(summary.answers).toEqual(["Ada"])
    expect(summary.answered).toBe(1)
    expect(summary.skipped).toBe(1)
  })

  it("computes the median as the mean of the two middle values on an even count", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "number", label: "Age" }
    const [summary] = summarizeResponses(
      [question],
      [{ q1: "1" }, { q1: "2" }, { q1: "3" }, { q1: "10" }]
    )
    if (summary.kind !== "number") throw new Error("expected a number summary")
    expect(summary.median).toBe(2.5)
    expect(summary.min).toBe(1)
    expect(summary.max).toBe(10)
    expect(summary.mean).toBe(4)
  })

  it("computes the median as the middle value on an odd count", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "number", label: "Age" }
    const [summary] = summarizeResponses(
      [question],
      [{ q1: "1" }, { q1: "5" }, { q1: "6" }]
    )
    if (summary.kind !== "number") throw new Error("expected a number summary")
    expect(summary.median).toBe(5)
  })

  it("counts an unparseable number as skipped instead of producing NaN", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "number", label: "Age" }
    const [summary] = summarizeResponses(
      [question],
      [{ q1: "4" }, { q1: "not a number" }]
    )
    if (summary.kind !== "number") throw new Error("expected a number summary")
    expect(summary.answered).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(Number.isNaN(summary.mean)).toBe(false)
    expect(summary.mean).toBe(4)
  })

  it("reports the earliest and latest date without parsing them", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "date", label: "When" }
    const [summary] = summarizeResponses(
      [question],
      [{ q1: "2026-03-05" }, { q1: "2025-12-31" }, { q1: "2026-11-02" }]
    )
    if (summary.kind !== "date") throw new Error("expected a date summary")
    expect(summary.earliest).toBe("2025-12-31")
    expect(summary.latest).toBe("2026-11-02")
  })

  it("returns empty strings for a date question with no answers", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "date", label: "When" }
    const [summary] = summarizeResponses([question], [])
    if (summary.kind !== "date") throw new Error("expected a date summary")
    expect(summary.answered).toBe(0)
    expect(summary.earliest).toBe("")
    expect(summary.latest).toBe("")
  })

  it("counts responses that attached a file", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "file_upload", label: "CV" }
    const [summary] = summarizeResponses(
      [question],
      [
        {
          q1: {
            attachmentId: "a1",
            filename: "cv.pdf",
            mimeType: "application/pdf",
            size: 10,
          },
        },
        {},
      ]
    )
    if (summary.kind !== "file") throw new Error("expected a file summary")
    expect(summary.attached).toBe(1)
    expect(summary.skipped).toBe(1)
  })

  it("returns one entry per question when there are no responses at all", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const summaries = summarizeResponses(
      [choiceQuestion(), { id: "q2", type: "short_text", label: "Name" }],
      []
    )
    expect(summaries).toHaveLength(2)
    expect(summaries[0].answered).toBe(0)
    expect(summaries[0].skipped).toBe(0)
    if (summaries[0].kind !== "choice") throw new Error("expected choice")
    expect(summaries[0].options).toEqual([
      { value: "A", count: 0 },
      { value: "B", count: 0 },
      { value: "C", count: 0 },
    ])
  })

  // Question types are editable, and `changeQuestionType` preserves the
  // question's id, so a stored answer can outlive the type it was recorded
  // under. These three cover the resulting mismatches: a summary must
  // tolerate them rather than crash.

  it("does not throw on a short_text question left with a checkboxes string[] answer, and counts it as skipped", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "short_text", label: "Name" }
    const [summary] = summarizeResponses(
      [question],
      [{ q1: ["A", "B"] }, { q1: "Ada" }]
    )
    if (summary.kind !== "text") throw new Error("expected a text summary")
    expect(summary.answers).toEqual(["Ada"])
    expect(summary.answered).toBe(1)
    expect(summary.skipped).toBe(1)
  })

  it("does not throw on a date question left with a file_upload FileAnswer object, and reports no answers", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const question: Question = { id: "q1", type: "date", label: "When" }
    const [summary] = summarizeResponses(
      [question],
      [
        {
          q1: {
            attachmentId: "a1",
            filename: "cv.pdf",
            mimeType: "application/pdf",
            size: 10,
          },
        },
      ]
    )
    if (summary.kind !== "date") throw new Error("expected a date summary")
    expect(summary.answered).toBe(0)
    expect(summary.earliest).toBe("")
    expect(summary.latest).toBe("")
    expect(summary.skipped).toBe(1)
  })

  it("does not throw on a multiple_choice question left with a file_upload FileAnswer object, and produces no bogus option", async () => {
    const { summarizeResponses } = await import("./response-summary")
    const [summary] = summarizeResponses(
      [choiceQuestion()],
      [
        { q1: "A" },
        {
          q1: {
            attachmentId: "a1",
            filename: "cv.pdf",
            mimeType: "application/pdf",
            size: 10,
          },
        },
      ]
    )
    if (summary.kind !== "choice") throw new Error("expected a choice summary")
    expect(summary.options).toEqual([
      { value: "A", count: 1 },
      { value: "B", count: 0 },
      { value: "C", count: 0 },
    ])
    expect(summary.answered).toBe(1)
    expect(summary.skipped).toBe(1)
  })
})
