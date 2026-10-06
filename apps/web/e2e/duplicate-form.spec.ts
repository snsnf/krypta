import type { Page } from "@playwright/test"
import { expect, shareLinkFor, startBlankForm, test, unlock } from "./fixtures"

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
)

function chooseOption(page: Page, option: string) {
  return page
    .locator("label", { has: page.locator(`input[type="radio"][value="${option}"]`) })
    .click()
}

test("duplicating a form copies its questions, rule and header image to a new link", async ({
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

  await page.getByLabel("Form title").fill("Original form")
  await page.getByLabel("Question label").fill("Coming?")
  await page.getByRole("combobox", { name: "Question type" }).selectOption("multiple_choice")
  const options = page.locator('input[placeholder^="Option "]')
  await options.nth(0).fill("Yes")
  await page.getByRole("button", { name: "+ Add option" }).click()
  await options.nth(1).fill("No")
  await page.getByRole("button", { name: "Add question" }).click()
  await page.getByLabel("Question label").nth(1).fill("Bringing anyone?")
  await page.getByRole("button", { name: /only show this if/i }).click()

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const originalLink = shareLinkFor(page)

  // At desktop width the Appearance panel is always open beside the builder;
  // only phones fold it behind a toggle.
  await page
    .getByLabel("Header image")
    .first()
    .setInputFiles({ name: "h.png", mimeType: "image/png", buffer: PNG })
  await expect(page.getByRole("button", { name: "Replace" }).first()).toBeVisible({
    timeout: 10_000,
  })

  await page.goto("/dashboard")
  await page.getByRole("button", { name: "Actions for Original form" }).click()
  await page.getByRole("menuitem", { name: "Duplicate" }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const copyLink = shareLinkFor(page)
  expect(copyLink).not.toBe(originalLink)
  await expect(page.getByRole("textbox", { name: "Form title" })).toHaveValue("Copy of Original form")

  const context = await browser.newContext()
  const respondent = await context.newPage()
  await respondent.goto(copyLink)
  // The header is decrypted in the browser and shown from a blob URL.
  await expect(respondent.locator('img[src^="blob:"]').first()).toBeVisible({ timeout: 10_000 })
  await expect(respondent.getByLabel("Bringing anyone?")).toHaveCount(0)
  await chooseOption(respondent, "Yes")
  await expect(respondent.getByLabel("Bringing anyone?")).toBeVisible()
  await context.close()
})
