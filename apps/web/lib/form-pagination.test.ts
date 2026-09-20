import { describe, expect, test } from "vitest"
import { splitFormIntoPages } from "./form-pagination"
import type { Question } from "@krypta/crypto"

function q(id: string, pageBreakBefore?: boolean): Question {
  return { id, type: "short_text", label: id, pageBreakBefore }
}

describe("splitFormIntoPages", () => {
  test("with no breaks, returns exactly one page", () => {
    const questions = [q("a"), q("b"), q("c")]
    expect(splitFormIntoPages(questions)).toEqual([questions])
  })

  test("splits at each pageBreakBefore boundary", () => {
    const questions = [q("a"), q("b", true), q("c"), q("d", true)]
    expect(splitFormIntoPages(questions)).toEqual([
      [q("a")],
      [q("b", true), q("c")],
      [q("d", true)],
    ])
  })

  test("a break on the first question is a no-op", () => {
    const questions = [q("a", true), q("b")]
    expect(splitFormIntoPages(questions)).toEqual([[q("a", true), q("b")]])
  })

  test("an empty form is a single empty page", () => {
    expect(splitFormIntoPages([])).toEqual([[]])
  })
})
