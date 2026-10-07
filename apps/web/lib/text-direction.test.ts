import { describe, expect, it } from "vitest"
import { autoDir } from "./text-direction"

describe("autoDir", () => {
  it("lets an empty field inherit the page's direction", () => {
    expect(autoDir("")).toBeUndefined()
    expect(autoDir(undefined)).toBeUndefined()
    expect(autoDir(null)).toBeUndefined()
  })

  it("lets typed text set its own direction", () => {
    expect(autoDir("سؤال")).toBe("auto")
    expect(autoDir("Question")).toBe("auto")
  })
})
