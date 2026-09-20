import { describe, expect, test } from "vitest"
import type { Question } from "@krypta/crypto"
import {
  buildVisibleSteps,
  clampStepIndex,
  initialStepIndex,
  stepBlockedBy,
} from "./form-steps"

function q(id: string, extra: Partial<Question> = {}): Question {
  return { id, type: "short_text", label: id, ...extra }
}

const upload = (id: string) => q(id, { type: "file_upload" })
const never = () => false
const always = () => true

describe("buildVisibleSteps", () => {
  test("Focus shows one question per step", () => {
    expect(buildVisibleSteps([q("a"), q("b")], {}, "focus")).toEqual([[q("a")], [q("b")]])
  })

  test("Classic shows a page per step, split at the breaks", () => {
    const questions = [q("a"), q("b", { pageBreakBefore: true }), q("c")]
    expect(buildVisibleSteps(questions, {}, "classic")).toEqual([
      [questions[0]],
      [questions[1], questions[2]],
    ])
  })

  test("the two layouts disagree about an empty form, and both are kept", () => {
    // Focus has no step to show, which is what drives its "no questions yet"
    // screen. Classic renders one empty page, as it always has.
    expect(buildVisibleSteps([], {}, "focus")).toEqual([])
    expect(buildVisibleSteps([], {}, "classic")).toEqual([[]])
  })
})

describe("visibility runs before the split, never after", () => {
  const source = q("src", {
    type: "multiple_choice",
    options: ["Yes", "No"],
  })

  test("a hidden question does not take a step of its own in Focus", () => {
    const dependent = q("dep", {
      condition: { questionId: "src", operator: "is", value: "Yes" },
    })
    expect(buildVisibleSteps([source, dependent], { src: "No" }, "focus")).toEqual(
      [[source]]
    )
    expect(
      buildVisibleSteps([source, dependent], { src: "Yes" }, "focus")
    ).toEqual([[source], [dependent]])
  })

  test("a page whose only question is hidden does not survive as an empty page", () => {
    // Splitting first and filtering afterwards leaves `[[source], []]` here,
    // which is a page a respondent has to click through with nothing on it.
    // The order is what prevents that, so it is not left to the caller.
    const onItsOwnPage = q("dep", {
      pageBreakBefore: true,
      condition: { questionId: "src", operator: "is", value: "Yes" },
    })
    expect(
      buildVisibleSteps([source, onItsOwnPage], { src: "No" }, "classic")
    ).toEqual([[source]])
    expect(
      buildVisibleSteps([source, onItsOwnPage], { src: "Yes" }, "classic")
    ).toEqual([[source], [onItsOwnPage]])
  })
})

describe("initialStepIndex", () => {
  test("an unanswered form starts at the beginning, as before drafts existed", () => {
    expect(initialStepIndex(buildVisibleSteps([q("a"), q("b")], {}, "focus"), {})).toBe(0)
  })

  test("a restored draft opens on the first question not yet answered", () => {
    const steps = buildVisibleSteps([q("a"), q("b"), q("c")], {}, "focus")
    expect(initialStepIndex(steps, { a: "one" })).toBe(1)
    expect(initialStepIndex(steps, { a: "one", b: "two" })).toBe(2)
  })

  test("it stops at the first gap rather than the furthest answer", () => {
    const steps = buildVisibleSteps([q("a"), q("b"), q("c")], {}, "focus")
    expect(initialStepIndex(steps, { a: "one", c: "three" })).toBe(1)
  })

  test("in Classic it opens the page holding that question, not the question's own index", () => {
    // The distinction Classic used to get wrong on its own: a question index
    // and a page index are not the same number once a form has breaks.
    const steps = buildVisibleSteps(
      [q("a"), q("b"), q("c", { pageBreakBefore: true }), q("d")],
      {},
      "classic"
    )
    expect(initialStepIndex(steps, { a: "one", b: "two" })).toBe(1)
    expect(initialStepIndex(steps, { a: "one" })).toBe(0)
  })

  test("a fully answered form lands on the last step, which carries submit", () => {
    const steps = buildVisibleSteps([q("a"), q("b")], {}, "focus")
    expect(initialStepIndex(steps, { a: "one", b: "two" })).toBe(1)
  })

  test("no steps at all is 0, never -1", () => {
    expect(initialStepIndex([], { a: "one" })).toBe(0)
  })
})

describe("clampStepIndex", () => {
  test("leaves an index that is already in range", () => {
    expect(clampStepIndex(buildVisibleSteps([q("a"), q("b")], {}, "focus"), 1)).toBe(1)
  })

  test("pulls an index past the end back to the last step", () => {
    // Cannot fire today, because a condition may only name an earlier
    // question. It becomes load-bearing the day that relaxes, and its absence
    // shows up as a blank screen rather than as an error.
    expect(clampStepIndex(buildVisibleSteps([q("a"), q("b")], {}, "focus"), 7)).toBe(1)
  })

  test("an empty form clamps to 0 rather than -1", () => {
    expect(clampStepIndex([], 3)).toBe(0)
  })
})

describe("stepBlockedBy", () => {
  const none = new Set<string>()

  test("nothing blocks a step that is answered and settled", () => {
    expect(stepBlockedBy([q("a")], none, never)).toBeNull()
  })

  test("a missing required answer blocks it", () => {
    expect(stepBlockedBy([q("a")], none, always)).toBe("required")
  })

  test("an upload still in flight blocks it", () => {
    expect(stepBlockedBy([upload("f")], new Set(["f"]), never)).toBe("uploading")
  })

  test("an upload on another step does not block this one", () => {
    expect(stepBlockedBy([upload("f")], new Set(["other"]), never)).toBeNull()
  })

  test("an unfinished upload is reported ahead of a missing required answer", () => {
    // The more specific thing to say. The file question is answered as far as
    // the respondent is concerned, and calling it required would send them
    // looking for a field they have already filled in.
    expect(stepBlockedBy([upload("f")], new Set(["f"]), always)).toBe(
      "uploading"
    )
  })

  test("only an upload question counts as uploading, whatever the set holds", () => {
    expect(stepBlockedBy([q("a")], new Set(["a"]), never)).toBeNull()
  })
})
