import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/utils", () => ({
  cn: (...values: string[]) => values.filter(Boolean).join(" "),
}))

import { shouldUsePointerPressFeedback } from "./button"

describe("Button press feedback", () => {
  it("enables transform feedback only for pointer presses when reduced motion is off", () => {
    expect(shouldUsePointerPressFeedback("mouse", false)).toBe(true)
    expect(shouldUsePointerPressFeedback("touch", false)).toBe(true)
    expect(shouldUsePointerPressFeedback("pen", false)).toBe(true)
    expect(shouldUsePointerPressFeedback("mouse", true)).toBe(false)
  })
})
