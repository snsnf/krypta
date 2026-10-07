import type { Page } from "@playwright/test"
import { expect, shareLinkFor, test, unlock, startBlankForm, choose } from "./fixtures"

/**
 * Click a `multiple_choice` option the way a respondent does.
 *
 * The radio itself is `sr-only`, a real <input type="radio"> clipped to 1x1,
 * so `getByRole("radio").check()` times out on actionability (the wrapping
 * span intercepts pointer events). The wrapping <label> is what is actually
 * visible and clickable; see the same helper in `full-flow.spec.ts`.
 */
function chooseOption(page: Page, option: string) {
  return page
    .locator("label", {
      has: page.locator(`input[type="radio"][value="${option}"]`),
    })
    .click()
}

/*
 * The claim this proves end to end: a quiz is scored for its members, its
 * manual grades persist, and nothing a respondent's browser receives carries
 * the answer key. The unit suites cover the scoring rules and the sealing;
 * what needs a browser is the builder, the public page's network traffic, and
 * a grade surviving a reload.
 */
test("a quiz is scored for members and its answers never reach a respondent", async ({
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

  await page.getByLabel("Form title").fill("Geography quiz")
  await page.getByLabel("Question label").fill("Capital of France")
  await choose(
    page.getByRole("combobox", { name: "Question type" }),
    "Multiple choice"
  )
  await page.getByRole("textbox", { name: "Option 1" }).fill("Paris")
  await page.getByRole("button", { name: "+ Add option" }).click()
  await page.getByRole("textbox", { name: "Option 2" }).fill("Lyon")

  await page.getByRole("button", { name: "Add question" }).click()
  await page.getByLabel("Question label").nth(1).fill("Why is it the capital")
  await choose(
    page.getByRole("combobox", { name: "Question type" }).nth(1),
    "Long answer"
  )

  // Quiz mode is a form setting, available on the draft before publishing.
  await page.getByRole("tab", { name: "Settings" }).click()
  const quizSwitch = page.getByRole("switch", { name: "Quiz" })
  await quizSwitch.click()
  await expect(quizSwitch).toBeChecked()

  await page.getByRole("tab", { name: "Questions" }).click()
  await page
    .getByRole("button", { name: "Answer key for question 1" })
    .click()
  await page.getByRole("button", { name: "Paris" }).click()
  await expect(page.getByRole("button", { name: "Paris" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await page
    .getByRole("button", { name: "Answer key for question 2" })
    .click()
  await page.getByLabel("Points").nth(1).fill("2")

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)

  const submissions = [
    ["Paris", "It is where the government sits"],
    ["Lyon", "Because of the food"],
  ] as const
  // One context per respondent: the one-response-per-person marker is
  // localStorage, so two submissions from one context is a different test.
  for (const [choice, why] of submissions) {
    const context = await browser.newContext()
    const respondent = await context.newPage()
    const publicForm = respondent.waitForResponse((response) =>
      response.url().includes("/public")
    )
    await respondent.goto(shareLink)
    const publicBody = await (await publicForm).text()
    expect(publicBody).not.toContain("answer_key")

    await chooseOption(respondent, choice)
    await respondent.getByLabel("Why is it the capital").fill(why)
    await respondent
      .getByTestId("form-theme-surface")
      .getByRole("button", { name: "Submit" })
      .click()
    await expect(respondent.getByText(/thanks/i)).toBeVisible()
    await context.close()
  }

  await page.reload()

  // The key survived the save and the reload.
  await page
    .getByRole("button", { name: "Answer key for question 1" })
    .click()
  await expect(page.getByRole("button", { name: "Paris" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )

  await page.getByRole("tab", { name: "Responses" }).click()
  await page.getByRole("button", { name: "Individual" }).click()

  const parisRow = page.getByRole("row", { name: /government/ })
  const lyonRow = page.getByRole("row", { name: /food/ })
  await expect(parisRow).toBeVisible({ timeout: 10_000 })
  await expect(
    parisRow.getByRole("button", { name: /Score for response/ })
  ).toHaveText("1 / 3")
  await expect(
    lyonRow.getByRole("button", { name: /Score for response/ })
  ).toHaveText("0 / 3")
  await expect(parisRow).toContainText("1 to grade")

  await parisRow.getByRole("button", { name: /Score for response/ }).click()
  const dialog = page.getByRole("dialog")
  await dialog
    .getByRole("listitem")
    .filter({ hasText: "Why is it the capital" })
    .getByRole("button", { name: "Correct", exact: true })
    .click()
  await expect(dialog.getByText("3 / 3")).toBeVisible()
  await dialog.getByRole("button", { name: "Done" }).click()
  await expect(
    parisRow.getByRole("button", { name: /Score for response/ })
  ).toHaveText("3 / 3")

  // The manual grade was saved, not just held on screen.
  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await page.getByRole("button", { name: "Individual" }).click()
  await expect(
    page
      .getByRole("row", { name: /government/ })
      .getByRole("button", { name: /Score for response/ })
  ).toHaveText("3 / 3", { timeout: 10_000 })

  await page.getByRole("button", { name: "Summary" }).click()
  const summary = page.getByTestId("quiz-summary")
  await expect(summary).toContainText("Average")
  await expect(summary).toContainText("3 / 3")
  await expect(summary).toContainText("1 response still needs grading")
})
