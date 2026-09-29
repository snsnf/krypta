import { expect, shareLinkFor, test, unlock, startBlankForm } from "./fixtures"

/*
 * Two options can end up with the same text while a creator is typing, and
 * every place a choice is stored (an answer, a condition, the quiz answer
 * key) names an option by that text. So the duplicate is not a second choice
 * at all: rendering it twice gave the respondent two radios that light up
 * together, and React two list children with the same key.
 *
 * Needs a browser: the warning is React's own console output, and the
 * respondent's radio group only exists in a DOM.
 */
test("duplicate option text is one choice, and the builder says so", async ({
  page,
  browser,
  sharedAccount,
}) => {
  const reactErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") reactErrors.push(message.text())
  })

  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)

  await page.getByLabel("Form title").fill("Duplicate options")
  await page.getByLabel("Question label").fill("Pick a number")
  await page
    .getByRole("combobox", { name: "Question type" })
    .selectOption("multiple_choice")
  await page.getByRole("textbox", { name: "Option 1" }).fill("2")
  await page.getByRole("button", { name: "+ Add option" }).click()
  await page.getByRole("textbox", { name: "Option 2" }).fill("2")

  await expect(
    page.getByText("Two options have the same text", { exact: false })
  ).toBeVisible()
  expect(reactErrors.filter((text) => text.includes("same key"))).toEqual([])

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)

  const context = await browser.newContext()
  const respondent = await context.newPage()
  await respondent.goto(shareLink)

  // One radio, not two that would check together.
  await expect(respondent.getByRole("radio", { name: "2" })).toHaveCount(1)
  await respondent
    .locator("label", { has: respondent.locator('input[value="2"]') })
    .click()
  await respondent
    .getByTestId("form-theme-surface")
    .getByRole("button", { name: "Submit" })
    .click()
  await expect(respondent.getByText(/thanks/i)).toBeVisible()
  await context.close()

  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await page.getByRole("button", { name: "Individual" }).click()
  await expect(page.getByRole("cell", { name: "2", exact: true })).toBeVisible({
    timeout: 10_000,
  })
})
