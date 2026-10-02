import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CipherReveal, canScramble } from "./cipher-reveal"

describe("canScramble", () => {
  it("scrambles Latin text but never a connected script", () => {
    // Each letter gets its own inline-block cell, which would show an Arabic
    // word as disconnected letters until the animation ends.
    expect(canScramble("Nothing here to unseal.")).toBe(true)
    expect(canScramble("لا شيء هنا لفك ختمه.")).toBe(false)
    expect(canScramble("krypta مرحبا")).toBe(false)
  })
})

describe("CipherReveal", () => {
  it("renders the real text as one plain run", () => {
    const markup = renderToStaticMarkup(<CipherReveal text="لا شيء هنا" />)
    expect(markup).toBe("<span>لا شيء هنا</span>")
  })
})
