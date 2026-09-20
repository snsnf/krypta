import { expect, shareLinkFor, test, unlock } from "./fixtures"

async function installIsolatedCorsRoute(page: import("@playwright/test").Page) {
  const isolatedApiBase = process.env.PLAYWRIGHT_API_BASE
  const isolatedWebBase = process.env.PLAYWRIGHT_BASE_URL
  if (!isolatedApiBase || !isolatedWebBase) return

  await page.route(`${isolatedApiBase}/**`, async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "access-control-allow-origin": new URL(isolatedWebBase).origin,
        "access-control-allow-credentials": "true",
      },
    })
  })
}

test.beforeEach(async ({ page }) => {
  await installIsolatedCorsRoute(page)
})

test("form detail page defaults to the Questions tab and switches correctly", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await page.getByRole("textbox", { name: "Form title" }).fill("Tabs test form")
  await page.getByRole("textbox", { name: "Question label" }).fill("Q1")
  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)

  await expect(page.getByRole("tab", { name: "Questions" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(page.getByRole("textbox", { name: "Form title" })).toBeVisible()

  await page.getByRole("tab", { name: "Responses" }).click()
  await expect(page.getByText("0 responses")).toBeVisible()

  await page.getByRole("tab", { name: "Settings" }).click()
  await expect(page.getByLabel("Limit to 1 response")).toBeVisible()
  await expect(page.getByLabel("Allow response editing")).toBeVisible()
  await expect(page.getByLabel("Accept responses")).toBeChecked()
})

test("closed public form blocks submission", async ({
  page,
  browser,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.getByRole("textbox", { name: "Form title" }).fill("Closed form")
  await page.getByRole("textbox", { name: "Question label" }).fill("Q1")
  await page.getByRole("button", { name: "Publish form" }).click()
  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const shareLinkText = shareLinkFor(page)

  await page.getByRole("tab", { name: "Settings" }).click()
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().includes("/api/v1/forms/")
    ),
    page.getByLabel("Accept responses").click(),
  ])

  const respondentContext = await browser.newContext()
  const respondentPage = await respondentContext.newPage()
  await installIsolatedCorsRoute(respondentPage)
  await respondentPage.goto(shareLinkText)
  await expect(
    respondentPage.getByText("This form is not accepting responses")
  ).toBeVisible()
  await expect(
    respondentPage.getByRole("button", { name: "Submit" })
  ).toHaveCount(0)
  await respondentContext.close()
})

test("limiting to 1 response blocks a second submission in the same browser", async ({
  page,
  browser,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await page.getByRole("textbox", { name: "Form title" }).fill("Limit-1 form")
  await page.getByRole("textbox", { name: "Question label" }).fill("Q1")
  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const shareLinkText = shareLinkFor(page)

  await page.getByRole("tab", { name: "Settings" }).click()
  await page.getByLabel("Limit to 1 response").click()
  await page.getByRole("tab", { name: "Questions" }).click()
  await page.click('button:has-text("Save changes")')
  await expect(page.getByText("Saving...")).toHaveCount(0)

  const respondentContext = await browser.newContext()
  const respondentPage = await respondentContext.newPage()
  await installIsolatedCorsRoute(respondentPage)
  await respondentPage.goto(shareLinkText)
  await respondentPage.fill("input", "First answer")
  await respondentPage.click('button:has-text("Submit")')
  await expect(respondentPage.getByText("Thanks!")).toBeVisible()

  await respondentPage.reload()
  await expect(
    respondentPage.getByText("You've already responded")
  ).toBeVisible()
  await respondentContext.close()
})

test("allowing response editing gives a link that updates the stored response", async ({
  page,
  browser,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await page.getByRole("textbox", { name: "Form title" }).fill("Editable form")
  await page.getByRole("textbox", { name: "Question label" }).fill("Q1")
  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const shareLinkText = shareLinkFor(page)

  await page.getByRole("tab", { name: "Settings" }).click()
  await page.getByLabel("Allow response editing").click()

  const respondentContext = await browser.newContext()
  const respondentPage = await respondentContext.newPage()
  await installIsolatedCorsRoute(respondentPage)
  await respondentPage.goto(shareLinkText)
  await respondentPage.fill("input", "Original answer")
  await respondentPage.click('button:has-text("Submit")')
  await expect(respondentPage.getByText("Thanks!")).toBeVisible()
  const editLinkText = await respondentPage.locator("code").last().textContent()
  expect(editLinkText).toContain("/f/")
  expect(editLinkText).toContain("/r#token=")
  expect(editLinkText).toContain("&key=")

  await respondentPage.goto(editLinkText!.trim())
  await respondentPage.fill("input", "Updated answer")
  await respondentPage.click('button:has-text("Save changes")')
  await expect(
    respondentPage.getByText("Your response was updated.")
  ).toBeVisible()

  // The responses list is fetched once when the form detail page loads;
  // it isn't polled or refetched on tab switch, so a reload is needed to
  // observe the response the respondent just submitted/edited.
  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await expect(page.getByText("Updated answer")).toBeVisible()
  await respondentContext.close()
})

test("a response limit closes the form to the next respondent", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await page.getByRole("textbox", { name: "Form title" }).fill("Limited form")
  await page.getByRole("textbox", { name: "Question label" }).fill("Your name")
  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)

  const shareLink = shareLinkFor(page)

  await page.getByRole("tab", { name: "Settings" }).click()
  await page.getByLabel("Response limit").fill("1")
  await page.getByLabel("Response limit").blur()

  const first = await page.context().newPage()
  await first.goto(shareLink)
  await first.getByRole("textbox").first().fill("Ada")
  await first.getByRole("button", { name: "Submit" }).click()
  await expect(first.getByText("Thanks!")).toBeVisible()

  const second = await page.context().newPage()
  await second.goto(shareLink)
  await expect(
    second.getByText("This form is not accepting responses")
  ).toBeVisible()
})

test("the response summary counts each chosen option", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await page.getByRole("textbox", { name: "Form title" }).fill("Summary form")
  await page.getByRole("textbox", { name: "Question label" }).fill("Pick one")
  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)

  const shareLink = shareLinkFor(page)

  const first = await page.context().newPage()
  await first.goto(shareLink)
  await first.getByRole("textbox").first().fill("Ada")
  await first.getByRole("button", { name: "Submit" }).click()
  await expect(first.getByText("Thanks!")).toBeVisible()

  const second = await page.context().newPage()
  await second.goto(shareLink)
  await second.getByRole("textbox").first().fill("Grace")
  await second.getByRole("button", { name: "Submit" }).click()
  await expect(second.getByText("Thanks!")).toBeVisible()

  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await expect(page.getByRole("button", { name: "Summary" })).toBeVisible()
  await expect(page.getByText("Pick one")).toBeVisible()
  await expect(page.getByText("2 answered")).toBeVisible()

  await page.getByRole("button", { name: "Individual" }).click()
  await expect(page.getByText("Ada")).toBeVisible()
})

test("deleting a response from the Individual view removes it from the table", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await page.getByRole("textbox", { name: "Form title" }).fill("Deletable form")
  await page.getByRole("textbox", { name: "Question label" }).fill("Your name")
  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)

  const shareLink = shareLinkFor(page)

  const respondent = await page.context().newPage()
  await respondent.goto(shareLink)
  await respondent.getByRole("textbox").first().fill("Ada")
  await respondent.getByRole("button", { name: "Submit" }).click()
  await expect(respondent.getByText("Thanks!")).toBeVisible()
  await respondent.close()

  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await page.getByRole("button", { name: "Individual" }).click()
  await expect(page.getByText("Ada")).toBeVisible()

  await page.getByRole("button", { name: "Delete response 1" }).click()
  await page
    .getByRole("button", { name: "Delete response", exact: true })
    .click()

  await expect(page.getByText("Ada")).toHaveCount(0)
})

test("a draft has every tab, and settings chosen before publishing stick", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await page.getByRole("textbox", { name: "Form title" }).fill("Draft tabs")
  await page.getByRole("textbox", { name: "Question label" }).fill("Q1")

  await page.getByRole("tab", { name: "Responses" }).click()
  await expect(page.getByText("No responses yet")).toBeVisible()
  await expect(
    page.getByText("This form isn't published, so nobody can answer it.", {
      exact: false,
    })
  ).toBeVisible()

  await page.getByRole("tab", { name: "Settings" }).click()
  // Nothing exists to delete yet, so there is no danger zone.
  await expect(page.getByText("Danger zone")).toBeHidden()
  const limit = page.getByLabel("Response limit")
  await limit.fill("5")
  await limit.blur()
  const message = page.getByLabel("Confirmation message")
  await message.fill("Thanks for your answers")
  await message.blur()
  await page.getByRole("switch", { name: "Allow response editing" }).click()

  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)

  await page.getByRole("tab", { name: "Settings" }).click()
  await expect(page.getByLabel("Response limit")).toHaveValue("5")
  await expect(page.getByLabel("Confirmation message")).toHaveValue(
    "Thanks for your answers"
  )
  await expect(
    page.getByRole("switch", { name: "Allow response editing" })
  ).toBeChecked()
})
