import {
  expect,
  shareLinkFor,
  test,
  unlock,
  startBlankForm,
  choose,
} from "./fixtures"

/*
 * The Other row is one label wrapping the control, the word and the text box,
 * which is what makes the whole row a target rather than just the small circle.
 * That shape rests on a browser behaviour worth proving rather than assuming:
 * a label's activation does nothing for clicks on its interactive descendants,
 * so typing in the box must not toggle the control back off. A checkbox is the
 * case where getting that wrong is visible, since it would uncheck.
 *
 * Needs a browser: the unit setup has no DOM, so neither label activation nor
 * focus can be exercised there.
 */
test("tapping anywhere on the Other row selects it, and typing does not undo that", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)

  await page.getByLabel("Form title").fill("Other row form")
  await page.getByLabel("Question label").fill("Pick colours")
  await choose(
    page.getByRole("combobox", { name: "Question type" }),
    "Checkboxes"
  )
  await page.getByRole("textbox", { name: "Option 1" }).fill("Red")
  await page.getByRole("checkbox", { name: /Add an .Other. choice/ }).click()

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)

  const respondent = await page.context().newPage()
  await respondent.goto(shareLink)

  const otherBox = respondent.getByRole("checkbox", { name: /Other/ })
  await expect(otherBox).not.toBeChecked()

  /*
   * Click the far right of the Other row, level with its checkbox. The x comes
   * from an ordinary option row, which has always spanned the full width, so
   * this lands on the part of the Other row that used to be dead space rather
   * than on the word "Other:". Measuring the Other label itself would not do:
   * before this fix that label hugged its own text, so its right edge WAS the
   * word and the click hit the one target that already worked.
   */
  const fullWidthRow = respondent.locator("label", { hasText: "Red" }).first()
  const rowBox = await fullWidthRow.boundingBox()
  const boxBox = await otherBox.boundingBox()
  if (!rowBox || !boxBox) throw new Error("Other row has no box")
  await respondent.mouse.click(
    rowBox.x + rowBox.width - 8,
    boxBox.y + boxBox.height / 2
  )

  await expect(otherBox).toBeChecked()

  const text = respondent.getByRole("textbox", { name: /Other answer for/ })
  await expect(text).toBeFocused()

  // Clicking into the box is a click inside the same label. If label activation
  // reached it, this would uncheck the row and throw the answer away.
  await text.click()
  await text.fill("Teal")
  await expect(otherBox).toBeChecked()
  await expect(text).toHaveValue("Teal")

  await respondent
    .getByTestId("form-theme-surface")
    .getByRole("button", { name: "Submit" })
    .click()
  await expect(respondent.getByText(/thanks/i)).toBeVisible()
})

test("a number question says it wants a number", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)

  await page.getByLabel("Form title").fill("Number form")
  await page.getByLabel("Question label").fill("How many")
  await choose(page.getByRole("combobox", { name: "Question type" }), "Number")

  await page.getByRole("button", { name: /publish form/i }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)

  const respondent = await page.context().newPage()
  await respondent.goto(shareLink)

  const field = respondent.getByLabel("How many")
  await expect(field).toHaveAttribute("placeholder", "Enter a number")
  // The keypad hint is the half of this that a phone respondent actually gets,
  // since the spinners type="number" relies on never render there.
  await expect(field).toHaveAttribute("inputmode", "decimal")
})
