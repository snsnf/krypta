import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/link", () => ({ default: "a" }))
vi.mock("./ui/button", () => ({ Button: "button" }))

import { AppLanguageContext } from "../lib/app-i18n"
import { InvitationCard } from "./invitation-card"

function render(language: "en" | "ar") {
  return renderToStaticMarkup(
    <AppLanguageContext.Provider value={language}>
      <InvitationCard
        view={{ kind: "wrong_account" }}
        switchingAccount={false}
        switchAccountError="Could not switch accounts. Try again."
        onAccept={vi.fn()}
        onDecline={vi.fn()}
        onSwitchAccount={vi.fn()}
      />
    </AppLanguageContext.Provider>
  )
}

describe("InvitationCard wrong-account failure", () => {
  it("keeps retry enabled and announces a generic switch failure", () => {
    const markup = render("en")
    expect(markup).toMatch(/aria-live="polite"[^>]*>Could not switch accounts/)
    const retry = markup.match(/<button[^>]*>Sign out and switch account/)
    expect(retry).not.toBeNull()
    expect(retry![0]).not.toContain("disabled")
  })

  it("speaks Arabic when the app does", () => {
    const markup = render("ar")
    expect(markup).toContain("استخدم الحساب المدعو")
    expect(markup).toContain("تسجيل الخروج وتبديل الحساب")
    expect(markup).not.toContain("Use the invited account")
  })
})
