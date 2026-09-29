import type { Page } from "@playwright/test"
import { expect, shareLinkFor, test, unlock } from "./fixtures"

function chooseRating(page: Page, value: string) {
  return page
    .locator("label", {
      has: page.locator(`input[type="radio"][value="${value}"]`),
    })
    .click()
}

test("a form started from a template is pre-filled and keeps its conditions", async ({
  page,
  browser,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new$/)

  await page.getByRole("button", { name: /event feedback/i }).click()
  await expect(page.getByRole("textbox", { name: "Form title" })).toHaveValue(
    "Event feedback"
  )
  await expect(page.getByLabel("Question label")).toHaveCount(4)

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)

  const context = await browser.newContext()
  const respondent = await context.newPage()
  await respondent.goto(shareLink)
  await chooseRating(respondent, "2")
  await expect(respondent.getByLabel("What went wrong?")).toBeVisible()
  await respondent.getByRole("button", { name: "Submit" }).click()
  await expect(respondent.getByText("Thanks for your feedback!")).toBeVisible()
  await context.close()
})
