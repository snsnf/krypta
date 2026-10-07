import {
  expect,
  shareLinkFor,
  test,
  unlock,
  startBlankForm,
  choose,
} from "./fixtures"

test("classic layout paginates at a section break and submits on the last page", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)

  await page.getByLabel("Form title").fill("Section break form")
  await page.getByLabel("Question label").fill("First question")

  await page.getByRole("button", { name: "Add question" }).click()
  const labels = page.getByLabel("Question label")
  await labels.nth(1).fill("Second question")
  await page.getByRole("button", { name: "Add section break" }).click()
  await page.getByPlaceholder("Section title (optional)").fill("Part two")

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)

  const shareLink = shareLinkFor(page)
  expect(shareLink).toContain("/f/")

  const publicPage = await page.context().newPage()
  await publicPage.goto(shareLink)
  const surface = publicPage.getByTestId("form-theme-surface")
  await expect(publicPage.getByText("Page 1 of 2")).toBeVisible()
  await publicPage.getByLabel("First question").fill("Ada")
  await surface.getByRole("button", { name: "Next" }).click()
  await expect(publicPage.getByText("Page 2 of 2")).toBeVisible()
  await expect(publicPage.getByText("Part two")).toBeVisible()
  await publicPage.getByLabel("Second question").fill("Lovelace")
  await surface.getByRole("button", { name: "Submit" }).click()
  await expect(publicPage.getByText(/thanks/i)).toBeVisible()
})

test("focus layout walks one question at a time via the appearance panel and keyboard", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)

  await page.getByLabel("Form title").fill("Focus form")
  await page.getByLabel("Question label").fill("First question")
  await page.getByRole("button", { name: "Add question" }).click()
  await page.getByLabel("Question label").nth(1).fill("Second question")
  await page.getByRole("button", { name: "Focus layout" }).click()
  await expect(
    page.getByRole("button", { name: "Focus layout" })
  ).toHaveAttribute("aria-pressed", "true")

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)

  const shareLink = shareLinkFor(page)
  expect(shareLink).toContain("/f/")
  const publicPage = await page.context().newPage()
  await publicPage.goto(shareLink)
  await publicPage.getByLabel("First question").fill("Grace")
  await publicPage.getByLabel("First question").press("Enter")
  await expect(publicPage.getByLabel("Second question")).toBeVisible()
  await expect(publicPage.getByLabel("First question")).not.toBeVisible()
  await publicPage.getByLabel("Second question").fill("Hopper")
  await publicPage.getByLabel("Second question").press("Enter")
  await expect(publicPage.getByText(/thanks/i)).toBeVisible()
})

/*
 * The option shortcuts are window-level, so choosing with a letter leaves focus
 * on the body and the form has no focused control to submit from. The screen
 * says "press Enter" throughout, so Enter has to advance from there too. This
 * needs a browser: the unit setup has no DOM, so neither the shortcut nor the
 * implicit submission it defeats can be exercised there.
 */
test("in Focus, a letter chooses an option and Enter moves on without the button", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)

  await page.getByLabel("Form title").fill("Shortcut form")
  await choose(
    page.getByRole("combobox", { name: "Question type" }).first(),
    "Multiple choice"
  )
  await page
    .getByRole("textbox", { name: "Question label" })
    .first()
    .fill("Pick one")
  const options = page.locator('input[placeholder^="Option "]')
  await options.nth(0).fill("Alpha")
  await page.click('button:has-text("+ Add option")')
  await options.nth(1).fill("Bravo")

  await page.getByRole("button", { name: "Add question" }).click()
  await page
    .getByRole("textbox", { name: "Question label" })
    .nth(1)
    .fill("Then this")
  await page.getByRole("button", { name: "Focus layout" }).click()
  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)

  const publicPage = await page.context().newPage()
  await publicPage.goto(shareLinkFor(page))
  await expect(publicPage.getByText("Pick one")).toBeVisible()

  // Nothing clicked, so focus is on the body: exactly the state the shortcut
  // leaves behind.
  await publicPage.keyboard.press("b")
  await expect(publicPage.getByRole("radio", { name: "Bravo" })).toBeChecked()

  await publicPage.keyboard.press("Enter")
  await expect(publicPage.getByLabel("Then this")).toBeVisible()
  await expect(publicPage.getByText("Pick one")).not.toBeVisible()
})
