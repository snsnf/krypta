import { expect, shareLinkFor, test, unlock } from "./fixtures"

/*
 * Searching responses filters in the browser, over answers the dashboard has
 * already decrypted, because the server holds ciphertext and no key.
 *
 * `lib/response-search.test.ts` covers the matching itself. What needs a
 * browser is the part that is about the screen rather than the strings: that a
 * narrowed table keeps each response's number from the full list. Numbering
 * the filtered rows instead would quietly rename response 2 to response 1 for
 * as long as a query is typed, so a number an owner reads off the screen, or
 * quotes to a collaborator, would mean a different response to each of them.
 */
test("searching narrows the responses without renumbering them", async ({
  page,
  browser,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)

  await page.getByLabel("Form title").fill("Search form")
  await page.getByLabel("Question label").fill("Your name")
  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)

  // One context per respondent: the one-response-per-person marker is
  // localStorage, so two submissions from one context is a different test.
  for (const name of ["Ana", "Bruno"]) {
    const context = await browser.newContext()
    const respondent = await context.newPage()
    await respondent.goto(shareLink)
    await respondent.getByLabel("Your name").fill(name)
    await respondent
      .getByTestId("form-theme-surface")
      .getByRole("button", { name: "Submit" })
      .click()
    await expect(respondent.getByText(/thanks/i)).toBeVisible()
    await context.close()
  }

  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await page.getByRole("button", { name: "Individual" }).click()

  const brunoRow = page.getByRole("row", { name: /Bruno/ })
  await expect(brunoRow).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("row", { name: /Ana/ })).toBeVisible()

  // Whatever position Bruno holds in the unfiltered list is what the row has
  // to keep showing once the list is narrowed to Bruno alone.
  const positionBeforeSearch = await brunoRow
    .getByRole("cell")
    .first()
    .innerText()

  const search = page.getByRole("searchbox", { name: "Search responses" })
  await search.fill("bruno")

  await expect(page.getByRole("row", { name: /Ana/ })).toBeHidden()
  await expect(brunoRow).toBeVisible()
  await expect(brunoRow.getByRole("cell").first()).toHaveText(
    positionBeforeSearch
  )
  await expect(page.getByText("1 of 2 responses")).toBeVisible()

  // Lowercase query against a capitalised answer: the fold is what makes the
  // feature usable, so it is worth proving through the real input.
  await search.fill("ANA")
  await expect(page.getByRole("row", { name: /Ana/ })).toBeVisible()
  await expect(page.getByRole("row", { name: /Bruno/ })).toBeHidden()

  await search.fill("nobody")
  await expect(page.getByText("No responses match that search.")).toBeVisible()
  await expect(page.getByText("0 of 2 responses")).toBeVisible()

  await page.getByRole("button", { name: "Clear search" }).click()
  await expect(page.getByRole("row", { name: /Ana/ })).toBeVisible()
  await expect(page.getByRole("row", { name: /Bruno/ })).toBeVisible()
})
