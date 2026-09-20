import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/utils", async () => vi.importActual("../lib/utils"))
vi.mock("@/components/ui/button", async () =>
  vi.importActual("./ui/button")
)
vi.mock("@/components/ui/checkbox", async () =>
  vi.importActual("./ui/checkbox")
)
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => {} } }))

import { RecoveryCodeCard } from "./recovery-code-card"

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
})
