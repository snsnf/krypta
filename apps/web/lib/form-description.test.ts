import { describe, expect, it } from "vitest"
import { normalizeFormDescription } from "./form-description"

describe("normalizeFormDescription", () => {
  it("keeps a written description exactly as typed", () => {
    expect(
      normalizeFormDescription(
        "Tell us about your visit.\nIt takes two minutes."
      )
    ).toBe("Tell us about your visit.\nIt takes two minutes.")
    expect(normalizeFormDescription("  وصف قصير  ")).toBe("  وصف قصير  ")
  })

  it("treats a blank description as none, so the schema leaves it out", () => {
    expect(normalizeFormDescription("")).toBeUndefined()
    expect(normalizeFormDescription("  \n ")).toBeUndefined()
    expect(normalizeFormDescription(undefined)).toBeUndefined()
  })

  it("refuses anything that is not text, since a decrypted schema is untrusted", () => {
    expect(normalizeFormDescription(42)).toBeUndefined()
    expect(normalizeFormDescription({ text: "hi" })).toBeUndefined()
    expect(normalizeFormDescription(["hi"])).toBeUndefined()
    expect(normalizeFormDescription(null)).toBeUndefined()
  })
})
