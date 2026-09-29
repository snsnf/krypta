import type { Page } from "@playwright/test"
import { expect, shareLinkFor, test, unlock, startBlankForm } from "./fixtures"

/*
 * The radios are sr-only, so the visible label is what a respondent clicks;
 * see chooseOption in quiz.spec.ts for why check() on the radio times out.
 */
function chooseRating(page: Page, value: string) {
  return page
    .locator("label", {
      has: page.locator(`input[type="radio"][value="${value}"]`),
    })
    .click()
}

test("a star rating reveals its follow-up at two stars and is summarised", async ({
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

  await page.getByLabel("Form title").fill("Rating form")
  await page.getByLabel("Question label").fill("How was the event?")
  await page
    .getByRole("combobox", { name: "Question type" })
    .selectOption("rating")
  await page.getByRole("button", { name: "Add question" }).click()
  await page.getByLabel("Question label").nth(1).fill("What went wrong?")
  await page.getByRole("button", { name: /only show this if/i }).click()
  await page
    .getByRole("combobox", { name: "Condition operator" })
    .selectOption("at_most")
  await page
    .getByRole("combobox", { name: "Condition value" })
    .selectOption("2")

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)

  for (const [stars, followUp] of [
    ["2", true],
    ["5", false],
  ] as const) {
    const context = await browser.newContext()
    const respondent = await context.newPage()
    await respondent.goto(shareLink)
    await chooseRating(respondent, stars)
    const question = respondent.getByLabel("What went wrong?")
    if (followUp) {
      await expect(question).toBeVisible()
      await question.fill("Too loud")
    } else {
      await expect(question).toHaveCount(0)
    }
    await respondent.getByRole("button", { name: "Submit" }).click()
    await expect(respondent.getByText(/thanks/i)).toBeVisible()
    await context.close()
  }

  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await page.getByRole("button", { name: "Summary" }).click()
  const summary = page.getByTestId("rating-summary")
  await expect(summary).toContainText("3.5")
  await expect(summary).toContainText("out of 5")
})
