import { expect, test } from "@playwright/test"
import {
  createVerifiedAccount,
  nextVerificationCodeFor,
  shareLinkFor,
  unlockAccount,
  verificationCodeFor,
  waitForInteractive,
} from "./fixtures"

// One registration per test via createVerifiedAccount (see full-flow.spec.ts's
// budget comment at the top): this file adds 2 to the suite's total.

test("a recovered account still decrypts everything it had", async ({
  page,
}) => {
  const account = await createVerifiedAccount("recovery")
  const { email, recoveryCode } = account
  // The account already has one mailed code from signup verification. Any
  // later code has to be told to skip past that one; see
  // nextVerificationCodeFor's doc comment.
  const signupCode = await verificationCodeFor(email)

  // Log in as the account normally (not via /recover) so there is something
  // pre-recovery to lose: a form, and a response submitted to it.
  await unlockAccount(page, account)

  await page.goto("/dashboard/new")
  await waitForInteractive(page)
  await page.getByRole("textbox", { name: "Form title" }).fill("Pre-recovery form")
  await page.getByRole("textbox", { name: "Question label" }).fill("How was it?")
  await page.getByRole("button", { name: "Publish form" }).click()
  await page.waitForURL(/\/dashboard\/.+\?created=1/)

  const dashboardPathname = new URL(page.url()).pathname
  const shareLink = shareLinkFor(page)
  expect(shareLink).toContain("/f/")

  await page.goto(shareLink)
  await waitForInteractive(page)
  await page.getByRole("textbox").first().fill("an answer from before")
  await page.getByRole("button", { name: /submit/i }).click()
  await expect(page.getByText(/thanks/i)).toBeVisible()

  // Forget the password.
  await page.goto("/recover")
  await waitForInteractive(page)
  await page.getByLabel("Email").fill(email)
  await page.getByRole("button", { name: "Send recovery code" }).click()

  const emailCode = await nextVerificationCodeFor(email, signupCode)
  await page.getByLabel("Emailed code").fill(emailCode)
  // Lowercased on purpose: the recovery-code input is meant to fold case (and
  // the I/L/O confusables) exactly the way a person transcribing it from paper
  // would type it.
  await page.getByLabel("Recovery code").fill(recoveryCode.toLowerCase())
  await page.getByRole("button", { name: "Verify" }).click()

  await page.getByLabel("New password").fill("a-brand-new-password")
  await page.getByRole("button", { name: "Set new password" }).click()

  // A fresh code is issued exactly once, and it is not the old one.
  const newCode = (
    await page.getByTestId("recovery-code").textContent()
  )!.trim()
  expect(newCode).not.toBe(recoveryCode)
  await page.getByRole("checkbox").click()
  await page.getByRole("button", { name: "Continue" }).click()

  // Log in with the new password and confirm the vault survived.
  await page.waitForURL(/\/login/)
  await waitForInteractive(page)
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill("a-brand-new-password")
  await page.getByRole("button", { name: "Log in" }).click()

  await page.waitForURL(/\/dashboard$/)
  await expect(page.getByText("Pre-recovery form")).toBeVisible()

  await page.goto(dashboardPathname)
  await waitForInteractive(page)
  await expect(page.getByRole("tab", { name: "Responses" })).toBeVisible()
  await page.getByRole("tab", { name: "Responses" }).click()
  await expect(page.getByText("an answer from before")).toBeVisible()
})

test("a spent recovery code is rejected on a second recovery attempt", async ({
  page,
}) => {
  const { email, recoveryCode } = await createVerifiedAccount("recovery")
  const signupCode = await verificationCodeFor(email)

  await page.goto("/recover")
  await waitForInteractive(page)
  await page.getByLabel("Email").fill(email)
  await page.getByRole("button", { name: "Send recovery code" }).click()
  const firstRecoverCode = await nextVerificationCodeFor(email, signupCode)
  await page.getByLabel("Emailed code").fill(firstRecoverCode)
  await page.getByLabel("Recovery code").fill(recoveryCode)
  await page.getByRole("button", { name: "Verify" }).click()

  await page.getByLabel("New password").fill("a-brand-new-password")
  await page.getByRole("button", { name: "Set new password" }).click()
  await page.getByTestId("recovery-code").waitFor()

  // Second attempt, same original (now-spent) code.
  await page.goto("/recover")
  await waitForInteractive(page)
  await page.getByLabel("Email").fill(email)
  await page.getByRole("button", { name: "Send recovery code" }).click()
  const secondRecoverCode = await nextVerificationCodeFor(
    email,
    firstRecoverCode
  )
  await page.getByLabel("Emailed code").fill(secondRecoverCode)
  await page.getByLabel("Recovery code").fill(recoveryCode)
  await page.getByRole("button", { name: "Verify" }).click()

  await expect(
    page.getByText(
      "That combination wasn't accepted. Check both codes and try again."
    )
  ).toBeVisible()
  // Still on the verify step: a rejected attempt must not advance the flow.
  await expect(page.getByLabel("New password")).toHaveCount(0)
})
