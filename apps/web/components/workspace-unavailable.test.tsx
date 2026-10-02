import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/link", () => ({
  default: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}))
vi.mock("@/lib/app-i18n", async () => vi.importActual("../lib/app-i18n"))
vi.mock("@/lib/form-load-failure", async () =>
  vi.importActual("../lib/form-load-failure")
)

import { WorkspaceUnavailable } from "./workspace-unavailable"
import { AppLanguageContext } from "../lib/app-i18n"

const pending = { key: "keysPending", retryable: true } as const

describe("WorkspaceUnavailable", () => {
  it("shows the failure in English as it always did", () => {
    const markup = renderToStaticMarkup(<WorkspaceUnavailable failure={pending} />)
    expect(markup).toContain("Waiting for the owner")
    expect(markup).toContain("Try again")
    expect(markup).toContain("Back to forms")
  })

  it("shows it in Arabic, buttons included", () => {
    const markup = renderToStaticMarkup(
      <AppLanguageContext value="ar">
        <WorkspaceUnavailable failure={pending} />
      </AppLanguageContext>
    )
    expect(markup).toContain("بانتظار المالك")
    expect(markup).toContain("حاول مرة أخرى")
    expect(markup).toContain("العودة إلى النماذج")
    expect(markup).not.toContain("Waiting for the owner")
  })
})
