import { test, expect } from "@playwright/test"
import {
  acknowledgeRecoveryCode,
  verificationCodeFor,
  waitForInteractive,
  startBlankForm,
} from "./fixtures"

// This is the one test in the whole passkey plan that drives a real WebAuthn
// ceremony. The point is not "enrolling a passkey works": it is that the
// SAME account key a form was created under is what a passkey login opens
// afterwards. If passkey enrolment ever produced a new account key instead of
// wrapping the existing one, this test is the only thing that would catch it:
// enrolment and login would both look like they succeeded, and a form created
// before the passkey existed would come back unreadable.
test("a passkey opens a vault created before it was enrolled", async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })

  const email = `e2e-passkey-${Date.now()}@example.com`
  const password = "correct horse battery staple"

  await page.goto("/signup")
  await waitForInteractive(page)
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')

  await page.getByLabel("Verification code").waitFor()
  const code = await verificationCodeFor(email)
  await page.getByLabel("Verification code").fill(code)
  await page.getByRole("button", { name: "Verify" }).click()
  await acknowledgeRecoveryCode(page)

  // A form that exists BEFORE the passkey does. Opening it afterwards is the
  // proof that a passkey wraps the same account key rather than a new one.
  // Client-side navigation only: a hard reload wipes the in-memory account
  // key and would bounce to /unlock before the form can be created.
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
  await page.click('a[href="/dashboard/new"]')
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)
  await waitForInteractive(page)
  const title = `Passkey proof ${Date.now()}`
  await page.getByRole("textbox", { name: "Form title" }).fill(title)
  await page
    .getByRole("textbox", { name: "Question label" })
    .fill("Does this still open?")
  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  await expect(page.getByText(title)).toBeVisible()

  // Client-side navigation again, via the header's own link, for the same
  // reason as above: the account key must survive into the settings page so
  // enrolPasskey has something to wrap.
  await page.getByRole("link", { name: "Account" }).click()
  await page.waitForURL(/\/dashboard\/settings/)
  await waitForInteractive(page)

  await page.getByPlaceholder(/name this device/i).fill("Test device")
  await page
    .getByLabel("Your password, to add a passkey")
    .fill("correct horse battery staple")
  await page.getByRole("button", { name: /add a passkey/i }).click()
  await expect(page.getByText(/test device/i)).toBeVisible()

  await page
    .getByRole("button", { name: /log out/i })
    .first()
    .click()
  await page.waitForURL(/\/login/)

  await page.goto("/login")
  await waitForInteractive(page)
  await page.getByRole("button", { name: /sign in with a passkey/i }).click()
  await page.waitForURL(/\/dashboard$/)

  // The proof: a form created before the passkey existed is readable through
  // a session that was opened with nothing but the passkey.
  await expect(page.getByText(title)).toBeVisible()
})
