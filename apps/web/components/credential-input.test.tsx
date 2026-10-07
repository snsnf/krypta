import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("@/lib/app-i18n", async () => vi.importActual("../lib/app-i18n"))
vi.mock("@/lib/form-language", async () => vi.importActual("../lib/form-language"))
vi.mock("@/lib/app-format", async () => vi.importActual("../lib/app-format"))
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}))

import { CredentialInput } from "./credential-input"
import { AppLanguageContext } from "../lib/app-i18n"

describe("CredentialInput", () => {
  it("keeps Latin credentials left to right and aligns them to the end in Arabic", () => {
    const ar = renderToStaticMarkup(
      <AppLanguageContext value="ar">
        <CredentialInput aria-label="Email" className="x" />
      </AppLanguageContext>
    )
    expect(ar).toContain('dir="ltr"')
    expect(ar).toContain("text-end")
    expect(ar).toContain("x")
  })

  it("leaves English fields exactly as they were apart from the explicit direction", () => {
    const en = renderToStaticMarkup(<CredentialInput aria-label="Email" />)
    expect(en).toContain('dir="ltr"')
    expect(en).not.toContain("text-end")
  })
})
