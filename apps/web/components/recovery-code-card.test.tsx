import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/utils", async () => vi.importActual("../lib/utils"))
vi.mock("@/lib/app-i18n", async () => vi.importActual("../lib/app-i18n"))
vi.mock("@/lib/recovery-file", async () => vi.importActual("../lib/recovery-file"))
vi.mock("@/components/ui/button", async () =>
  vi.importActual("./ui/button")
)
vi.mock("@/components/ui/checkbox", async () =>
  vi.importActual("./ui/checkbox")
)
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => {} } }))

import { RecoveryCodeCard } from "./recovery-code-card"
import { AppLanguageContext } from "../lib/app-i18n"

const code = "A3F9-2K7M-0P1Q-RSTV-WXYZ-1234-5678-9ABC"

function render() {
  return renderToStaticMarkup(
    <RecoveryCodeCard code={code} onConfirm={() => {}} />
  )
}

describe("RecoveryCodeCard", () => {
  it("shows the code", () => {
    expect(render()).toContain(code)
  })

  it("exposes the code under the test id the e2e suite locates it by", () => {
    expect(render()).toContain('data-testid="recovery-code"')
  })

  it("says what the code is for and that it is shown once", () => {
    const html = render()
    expect(html).toMatch(/only time/i)
    expect(html).toMatch(/forget your password/i)
  })

  it("distinguishes itself from a two-factor recovery code", () => {
    expect(render()).toMatch(/two-factor/i)
  })

  it("starts with the confirmation disabled", () => {
    expect(render()).toContain("disabled")
  })

  it("warns in Arabic, keeps the code itself left to right and emphasises the not", () => {
    const markup = renderToStaticMarkup(
      <AppLanguageContext value="ar">
        <RecoveryCodeCard code={code} onConfirm={() => {}} />
      </AppLanguageContext>
    )
    expect(markup).toContain("احفظ رمز الاسترداد")
    expect(markup).toContain("وبدونه تبقى مشفّرة إلى الأبد")
    expect(markup).toMatch(/<strong[^>]*>ليس<\/strong>/)
    expect(markup).toMatch(/dir="ltr"[^>]*data-testid="recovery-code"/)
    expect(markup).not.toContain("Save your recovery code")
  })
})
