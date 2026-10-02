import { describe, expect, it } from "vitest"
import { appTranslator } from "./app-translator"
import { recoveryFileText } from "./recovery-file"

const code = "A3F9-2K7M-0P1Q-RSTV-WXYZ-1234-5678-9ABC"

describe("recoveryFileText", () => {
  it("is exactly the English file it always was", () => {
    expect(recoveryFileText(code, appTranslator("en"), "en")).toBe(
      "Krypta vault recovery code\n\n" +
        `${code}\n\n` +
        "This recovers your encrypted forms and responses if you forget your\n" +
        "password. It is not a two-factor recovery code. Keep it somewhere\n" +
        "only you can reach. Nobody can reissue it.\n"
    )
  })

  it("starts an Arabic file with a byte-order mark so older editors read it as UTF-8", () => {
    const text = recoveryFileText(code, appTranslator("ar"), "ar")
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text).toContain(code)
    expect(text).toContain("لا يمكن لأحد إعادة إصداره.")
  })
})
