import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }))
vi.mock("@/lib/app-i18n", async () => vi.importActual("../lib/app-i18n"))
vi.mock("@/lib/app-locale", async () => vi.importActual("../lib/app-locale"))
vi.mock("@/lib/form-language", async () => vi.importActual("../lib/form-language"))
vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}))
vi.mock("@/components/ui/dropdown-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuRadioGroup: Passthrough,
    DropdownMenuRadioItem: Passthrough,
    DropdownMenuTrigger: Passthrough,
  }
})

import { AuthLanguageToggle } from "./language-switcher"
import { AppLanguageContext } from "../lib/app-i18n"

describe("AuthLanguageToggle", () => {
  it("offers the other language by its own name", () => {
    const en = renderToStaticMarkup(<AuthLanguageToggle />)
    expect(en).toContain("العربية")
    expect(en).toContain('lang="ar"')
    const ar = renderToStaticMarkup(
      <AppLanguageContext value="ar">
        <AuthLanguageToggle />
      </AppLanguageContext>
    )
    expect(ar).toContain("English")
    expect(ar).toContain('lang="en"')
    expect(ar).toContain('aria-label="اللغة: English"')
  })
})
