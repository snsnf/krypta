import { expect, shareLinkFor, test, unlock, startBlankForm } from "./fixtures"

/*
 * Draft persistence is browser behavior end to end: a state change, a
 * debounced write to localStorage, a reload, and a restore during the first
 * render. The unit setup has no DOM and no storage, so `lib/form-draft.ts` is
 * the only part of this that can be asserted there. What the respondent
 * actually experiences is only provable here.
 */

async function publishTwoQuestionForm(
  page: import("@playwright/test").Page,
  title: string
) {
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)
  await page.getByLabel("Form title").fill(title)
  await page.getByLabel("Question label").fill("First question")
  await page.getByRole("button", { name: "Add question" }).click()
  await page.getByLabel("Question label").nth(1).fill("Second question")
  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  return shareLinkFor(page)
}

test("a half-filled form comes back after a reload, and submitting clears it", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  const shareLink = await publishTwoQuestionForm(page, "Draft form")

  const publicPage = await page.context().newPage()
  await publicPage.goto(shareLink)
  await publicPage.getByLabel("First question").fill("Ada")
  // The notice tracks the write landing, not what is on screen, so waiting on
  // it waits on the debounced save itself rather than standing in for it.
  await expect(publicPage.getByText(/saved on this device/i)).toBeVisible()

  await publicPage.reload()
  await expect(publicPage.getByLabel("First question")).toHaveValue("Ada")

  await publicPage.getByLabel("Second question").fill("Lovelace")
  await publicPage
    .getByTestId("form-theme-surface")
    .getByRole("button", { name: "Submit" })
    .click()
  await expect(publicPage.getByText(/thanks/i)).toBeVisible()

  // A draft that outlives its submission is readable content nobody expects to
  // still be there, so the form must come back empty rather than pre-filled.
  //
  // reload, not goto: the confirmation screen lives at the share link's own
  // URL, so navigating to it again is a same-document fragment navigation that
  // never reloads and would leave this asserting against the "Thanks" screen.
  await publicPage.reload()
  await expect(publicPage.getByLabel("First question")).toHaveValue("")
  await expect(publicPage.getByText(/saved on this device/i)).toBeHidden()
})

test("discarding the saved answers empties the form and does not write them back", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  const shareLink = await publishTwoQuestionForm(page, "Discard draft form")

  const publicPage = await page.context().newPage()
  await publicPage.goto(shareLink)
  await publicPage.getByLabel("First question").fill("Grace")
  await expect(publicPage.getByText(/saved on this device/i)).toBeVisible()

  await publicPage.getByRole("button", { name: /discard saved answers/i }).click()
  await expect(publicPage.getByLabel("First question")).toHaveValue("")
  await expect(publicPage.getByText(/saved on this device/i)).toBeHidden()

  await publicPage.reload()
  await expect(publicPage.getByLabel("First question")).toHaveValue("")
})


test("a form edited after the draft was written drops only the answers that no longer fit", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  const shareLink = await publishTwoQuestionForm(page, "Reconciled draft form")

  const publicPage = await page.context().newPage()
  await publicPage.goto(shareLink)
  await publicPage.getByLabel("First question").fill("roughly weekly")
  await publicPage.getByLabel("Second question").fill("Lovelace")
  await expect(publicPage.getByText(/saved on this device/i)).toBeVisible()

  // The creator turns the free text question into a multiple choice one. What
  // the respondent typed is still a string, so it restores and still counts as
  // answered, but it matches no option: without reconciliation they would come
  // back to an unselected set of radios that nothing asks them to fill in, and
  // the old sentence would be sealed into their response anyway.
  await page
    .getByRole("combobox", { name: "Question type" })
    .first()
    .selectOption("multiple_choice")
  const options = page.locator('input[placeholder^="Option "]')
  await options.nth(0).fill("Daily")
  await page.click('button:has-text("+ Add option")')
  await options.nth(1).fill("Weekly")
  await page.click('button:has-text("Save changes")')
  await expect(page.getByText("Saving...")).toHaveCount(0)

  await publicPage.reload()
  await expect(
    publicPage.getByText(/no longer fit it and were cleared/i)
  ).toBeVisible()
  // Only the answer that stopped fitting is dropped. Discarding the whole draft
  // on any edit would take this one with it, over a change that never touched
  // the question it belongs to.
  await expect(publicPage.getByLabel("Second question")).toHaveValue("Lovelace")
})
