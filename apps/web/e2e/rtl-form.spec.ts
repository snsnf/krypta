import { expect, shareLinkFor, startBlankForm, test, unlock } from "./fixtures"

test("an Arabic form reaches respondents right to left, in Arabic", async ({
  page,
  browser,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)

  await page.getByRole("textbox", { name: "Form title" }).fill("نموذج")
  await page.getByLabel("Question label").fill("الاسم")
  await page.getByRole("switch", { name: "Required" }).click()
  // At desktop width the Appearance panel sits open beside the builder.
  await page.getByLabel("Form language").first().selectOption("ar")

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)

  const context = await browser.newContext()
  const respondent = await context.newPage()
  await respondent.goto(shareLink)
  const surface = respondent.getByTestId("form-theme-surface").first()
  await expect(surface).toHaveAttribute("dir", "rtl")
  await expect(surface).toHaveAttribute("lang", "ar")
  const submit = respondent.getByRole("button", { name: "إرسال" })
  await expect(submit).toBeDisabled()
  await respondent.getByLabel("الاسم").fill("سارة")
  await submit.click()
  await expect(respondent.getByText("شكرًا! تم إرسال ردك.")).toBeVisible()
  await context.close()
})
