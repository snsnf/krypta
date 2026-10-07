import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }))
vi.mock("@/lib/auth-store", () => ({
  useAuthStore: { getState: () => ({ userId: null }) },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }))
vi.mock("@/lib/app-i18n", async () => vi.importActual("../lib/app-i18n"))
vi.mock("@/lib/app-locale", async () => vi.importActual("../lib/app-locale"))
vi.mock("@/lib/form-language", async () => vi.importActual("../lib/form-language"))
vi.mock("@/lib/app-format", async () => vi.importActual("../lib/app-format"))
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
    // The language attribute sits on the name alone, so a screen reader voices
    // "Language:" in the page's language and the name in its own.
    expect(en).toContain('<span lang="ar">العربية</span>')
    expect(en).not.toMatch(/<button[^>]*lang=/)
    const ar = renderToStaticMarkup(
      <AppLanguageContext value="ar">
        <AuthLanguageToggle />
      </AppLanguageContext>
    )
    expect(ar).toContain('<span lang="en">English</span>')
    expect(ar).toContain('aria-label="اللغة: English"')
  })
})
