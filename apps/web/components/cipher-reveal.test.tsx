import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CipherReveal, canScramble, shownText } from "./cipher-reveal"

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

describe("shownText", () => {
  it("shows a scramble frame only while it belongs to the current text", () => {
    const frame = {
      text: "Forms only you can read.",
      scrambled: "F#r%s only you can read.",
    }
    expect(shownText(frame, "Forms only you can read.")).toBe(frame.scrambled)
    // Switching language mid animation must show the new text at once, not
    // the old frame: Arabic never scrambles, so nothing else would replace it.
    expect(shownText(frame, "نماذج لا يقرؤها سواك.")).toBe(
      "نماذج لا يقرؤها سواك."
    )
    expect(shownText(null, "نماذج لا يقرؤها سواك.")).toBe(
      "نماذج لا يقرؤها سواك."
    )
  })
})
