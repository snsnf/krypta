import { describe, expect, it } from "vitest"
import { encodeBase32, normalizeBase32 } from "../src/base32"

describe("crockford base32", () => {
  it("encodes 20 bytes as exactly 32 characters", () => {
    expect(encodeBase32(new Uint8Array(20))).toHaveLength(32)
  })

  it("never emits the excluded letters", () => {
    for (let i = 0; i < 50; i++) {
      const encoded = encodeBase32(Uint8Array.from({ length: 20 }, () => i * 5 + 1))
      expect(encoded).not.toMatch(/[ILOU]/)
    }
  })

  it("folds transcription errors when normalizing", () => {
    expect(normalizeBase32("il-o0 aB")).toBe("110" + "0AB")
  })
})
