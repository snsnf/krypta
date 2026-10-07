import type { Page } from "@playwright/test"
import {
  expect,
  shareLinkFor,
  test,
  unlock,
  startBlankForm,
  choose,
} from "./fixtures"

type PageCookies = Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>>

/** Fonts are self-hosted; a request to Google is a regression, so fail it. */
async function blockExternalGoogleFontRequests(page: Page) {
  await page.route("https://fonts.googleapis.com/**", (route) => route.abort())
  await page.route("https://fonts.gstatic.com/**", (route) => route.abort())
}

async function mockFontCatalog(page: Page) {
  await page.route("**/api/fonts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        fonts: [
          {
            id: "fraunces",
            family: "Fraunces",
            category: "serif",
            variants: ["regular"],
          },
          {
            id: "roboto",
            family: "Roboto",
            category: "sans-serif",
            variants: ["regular"],
          },
          {
            id: "noto-sans-arabic",
            family: "Noto Sans Arabic",
            category: "sans-serif",
            variants: ["regular", "700"],
          },
        ],
      }),
    })
  )
}

async function loginAndOpenNewForm(
  page: Page,
  account: { email: string; password: string; sessionCookies: PageCookies },
  mockFonts = true
) {
  await blockExternalGoogleFontRequests(page)
  if (mockFonts) {
    await mockFontCatalog(page)
  }
  await page.context().addCookies(account.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, account.password)
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)
}

test("builder is wide and applies appearance changes live", async ({
  page,
  sharedAccount,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await loginAndOpenNewForm(page, sharedAccount)

  const workspace = page.getByTestId("form-builder-workspace")
  const surface = page.getByTestId("form-theme-surface")
  expect((await workspace.boundingBox())?.width).toBeGreaterThan(1100)
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible()

  await page.getByRole("button", { name: "Ocean theme" }).click()
  await expect(surface).toHaveCSS("background-color", "rgb(232, 240, 247)")

  await page.getByLabel("Accent color hex").fill("#a35442")
  await expect(page.getByLabel("Accent color hex")).toHaveValue("#a35442")

  await page.getByRole("switch", { name: "Allow dark mode" }).click()
  await expect(
    page.getByRole("switch", { name: "Allow dark mode" })
  ).toBeChecked()

  await page.getByRole("combobox", { name: "Header font" }).click()
  await page.getByPlaceholder("Search fonts").fill("Noto Sans Arabic")
  await page.getByRole("option", { name: "Noto Sans Arabic" }).click()
  await choose(page.getByLabel("Header size"), "30px")
  await choose(page.getByLabel("Question size"), "16px")
  await choose(page.getByLabel("Text size"), "18px")
  await expect(page.getByLabel("Form title")).toHaveCSS("font-size", "30px")
  await expect(page.getByLabel("Question label")).toHaveCSS("font-size", "16px")

  await choose(page.getByLabel("Header weight and style"), "Bold")
  await expect(page.getByLabel("Form title")).toHaveCSS("font-weight", "700")
})

test("catalog fonts remain selected and load only after catalog validation", async ({
  page,
  sharedAccount,
}) => {
  await loginAndOpenNewForm(page, sharedAccount)

  await page.getByRole("combobox", { name: "Header font" }).click()
  await page.getByPlaceholder("Search fonts").fill("Roboto")
  await page.getByRole("option", { name: "Roboto" }).click()

  await expect(
    page.getByRole("combobox", { name: "Header font" })
  ).toContainText("Roboto")
  await expect(page.getByLabel("Form title")).toHaveCSS("font-family", /Roboto/)
  await expect(
    page.locator('link[data-form-typography-font="Roboto"]')
  ).toHaveAttribute("href", "/fonts/roboto.css")
})

test("appearance collapses into the mobile flow without horizontal overflow", async ({
  page,
  sharedAccount,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await loginAndOpenNewForm(page, sharedAccount)

  const toggle = page.getByRole("button", { name: "Appearance" })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(
    page.locator('[data-slot="collapsible-content"]').getByText("Theme presets")
  ).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(375)
})

test("appearance remains collapsible in the tablet flow", async ({
  page,
  sharedAccount,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await loginAndOpenNewForm(page, sharedAccount)

  const toggle = page.getByRole("button", { name: "Appearance" })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(
    page.locator('[data-slot="collapsible-content"]').getByText("Theme presets")
  ).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(768)
})

test("external theme changes clear stale invalid color edits", async ({
  page,
  sharedAccount,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await loginAndOpenNewForm(page, sharedAccount)

  await page.getByRole("button", { name: "Forest theme" }).click()
  await page.getByLabel("Accent color hex").fill("invalid")
  await expect(page.getByText("Use a six-digit hex color.")).toBeVisible()
  await page.getByRole("button", { name: "Ocean theme" }).click()
  await page.getByRole("button", { name: "Forest theme" }).click()
  await expect(page.getByLabel("Accent color hex")).toHaveValue("#356343")
  await expect(page.getByText("Use a six-digit hex color.")).toBeHidden()
})

test("a font failure stays inline, and an unsaved form cannot take an image", async ({
  page,
  sharedAccount,
}) => {
  await page.route("**/api/fonts", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
  )
  await loginAndOpenNewForm(page, sharedAccount, false)
  await page.getByLabel("Form title").fill("Fallback survey")
  await page.getByRole("combobox", { name: "Header font" }).click()
  await expect(
    page.getByText("The font list could not be loaded.")
  ).toBeVisible()
  await expect(
    page.getByText("Save the form first, then you can add a header image.")
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Publish form" })).toBeEnabled()
})

test("saved appearance renders on edit, preview, and public form", async ({
  page,
  browser,
  sharedAccount,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await loginAndOpenNewForm(page, sharedAccount)
  await page.getByLabel("Form title").fill("Community survey")
  await page.getByLabel("Question label").fill("What is your name?")
  await page.getByRole("button", { name: "Ocean theme" }).click()
  await page.getByRole("switch", { name: "Allow dark mode" }).click()
  await page.getByRole("combobox", { name: "Header font" }).click()
  await page.getByRole("option", { name: "Noto Sans Arabic" }).click()
  await page.getByRole("combobox", { name: "Question font" }).click()
  await page
    .locator('[role="option"]:visible', { hasText: "Roboto" })
    .last()
    .click()
  await page.getByRole("combobox", { name: "Text font" }).click()
  await page
    .locator('[role="option"]:visible', { hasText: "Fraunces" })
    .last()
    .click()
  await choose(page.getByLabel("Header size"), "30px")
  await choose(page.getByLabel("Question size"), "16px")
  await choose(page.getByLabel("Text size"), "18px")

  await page.getByRole("button", { name: "Preview" }).click()
  const preview = page.getByRole("dialog")
  await preview.getByRole("button", { name: "Dark preview" }).click()
  await expect(preview.getByTestId("form-theme-surface")).toHaveAttribute(
    "data-form-mode",
    "dark"
  )
  await expect(preview.getByText("Community survey")).toHaveCSS(
    "font-family",
    /Noto Sans Arabic/
  )
  await expect(preview.getByText("Community survey")).toHaveCSS(
    "font-size",
    "30px"
  )
  await expect(preview.getByText("What is your name?")).toHaveCSS(
    "font-family",
    /Roboto/
  )
  await expect(preview.getByText("What is your name?")).toHaveCSS(
    "font-size",
    "16px"
  )
  await expect(preview.getByRole("button", { name: "Submit" })).toHaveCSS(
    "font-family",
    /Fraunces/
  )
  await expect(preview.getByRole("button", { name: "Submit" })).toHaveCSS(
    "font-size",
    "18px"
  )
  await expect(
    preview.getByRole("button", { name: "Dark preview" })
  ).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Publish form" }).click()
  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const shareLink = shareLinkFor(page)
  expect(shareLink).toBeTruthy()

  await expect(
    page.getByRole("button", { name: "Ocean theme" })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("combobox", { name: "Header font" })
  ).toContainText("Noto Sans Arabic")
  await expect(
    page.getByRole("combobox", { name: "Question font" })
  ).toContainText("Roboto")
  await expect(page.getByRole("combobox", { name: "Text font" })).toContainText(
    "Fraunces"
  )
  await expect(page.getByLabel("Header size")).toHaveText("30px")
  await expect(page.getByLabel("Question size")).toHaveText("16px")
  await expect(page.getByLabel("Text size")).toHaveText("18px")

  const context = await browser.newContext({ colorScheme: "dark" })
  const respondent = await context.newPage()
  await blockExternalGoogleFontRequests(respondent)
  await mockFontCatalog(respondent)
  await respondent.goto(shareLink)
  await expect(respondent.getByTestId("form-theme-surface")).toHaveCSS(
    "background-color",
    /^oklch\(0\.18 0\.015 244\.\d+\)$/
  )
  await expect(respondent.getByTestId("form-theme-surface")).toHaveAttribute(
    "data-form-mode",
    "dark"
  )
  const modes = respondent.getByRole("radiogroup", { name: "Form color mode" })
  // Until someone chooses, the form follows the device, which is dark here.
  await expect(modes.getByRole("radio", { name: "System" })).toHaveAttribute(
    "aria-checked",
    "true"
  )
  await modes.getByRole("radio", { name: "Light" }).click()
  await modes.getByRole("radio", { name: "Dark" }).click()
  await expect(modes.getByRole("radio", { name: "Dark" })).toHaveAttribute(
    "aria-checked",
    "true"
  )
  // System hands the choice back to the device.
  await modes.getByRole("radio", { name: "Light" }).click()
  await modes.getByRole("radio", { name: "System" }).click()
  await expect(respondent.getByTestId("form-theme-surface")).toHaveAttribute(
    "data-form-mode",
    "dark"
  )
  await modes.getByRole("radio", { name: "Light" }).click()
  await expect(respondent.getByTestId("form-theme-surface")).toHaveAttribute(
    "data-form-mode",
    "light"
  )
  await expect(respondent.getByTestId("form-theme-surface")).toHaveCSS(
    "background-color",
    "rgb(232, 240, 247)"
  )
  await expect(
    respondent.getByRole("heading", { name: "Community survey" })
  ).toHaveCSS("font-family", /Noto Sans Arabic/)
  await expect(
    respondent.getByRole("heading", { name: "Community survey" })
  ).toHaveCSS("font-size", "30px")
  await expect(
    respondent.getByText("What is your name?", { exact: true })
  ).toHaveCSS("font-family", /Roboto/)
  await expect(
    respondent.getByText("What is your name?", { exact: true })
  ).toHaveCSS("font-size", "16px")
  await expect(respondent.getByLabel("What is your name?")).toHaveCSS(
    "font-family",
    /Fraunces/
  )
  await expect(respondent.getByLabel("What is your name?")).toHaveCSS(
    "font-size",
    "18px"
  )
  await respondent.getByLabel("What is your name?").fill("Maya")
  await expect(respondent.getByRole("button", { name: "Submit" })).toHaveCSS(
    "font-family",
    /Fraunces/
  )
  await expect(respondent.getByRole("button", { name: "Submit" })).toHaveCSS(
    "font-size",
    "18px"
  )
  await expect(respondent.getByRole("button", { name: "Submit" })).toHaveCSS(
    "background-color",
    "rgb(63, 100, 137)"
  )
  await respondent.getByRole("button", { name: "Submit" }).click()
  await expect(
    respondent.getByText("Thanks! Your response was submitted.")
  ).toBeVisible()
  await context.close()
})

test("a light-only form stays light inside a dark app shell", async ({
  page,
  browser,
  sharedAccount,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await loginAndOpenNewForm(page, sharedAccount)
  await page.getByLabel("Form title").fill("Light-only survey")
  await page.getByLabel("Question label").fill("Your name")
  await page.getByRole("button", { name: "Add question" }).click()
  await page.getByLabel("Question label").nth(1).fill("Choose an option")
  await choose(
    page.getByRole("combobox", { name: "Question type" }).nth(1),
    "Checkboxes"
  )
  await page.locator('input[aria-label="Option 1"]').fill("Selected choice")
  await page.getByRole("button", { name: "Publish form" }).click()
  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const shareLink = shareLinkFor(page)
  expect(shareLink).toBeTruthy()

  const context = await browser.newContext({ colorScheme: "dark" })
  const respondent = await context.newPage()
  await blockExternalGoogleFontRequests(respondent)
  await mockFontCatalog(respondent)
  await respondent.goto(shareLink)
  await respondent.evaluate(() =>
    document.documentElement.classList.add("dark")
  )

  const surface = respondent.getByTestId("form-theme-surface")
  await expect(surface).toHaveAttribute("data-form-mode", "light")
  await expect(surface).toHaveCSS("background-color", "rgb(232, 241, 233)")
  await expect(respondent.getByLabel("Your name")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)"
  )
  await expect(
    respondent.getByRole("checkbox", { name: "Selected choice" })
  ).toHaveCSS("background-color", "rgb(232, 241, 233)")
  await expect(respondent.getByRole("button", { name: "Submit" })).toHaveCSS(
    "background-color",
    "rgb(53, 99, 67)"
  )
  await expect(respondent.getByText("Your name").locator("..")).toHaveCSS(
    "background-color",
    "oklch(1 0 0)"
  )
  await expect(
    respondent.getByRole("radiogroup", { name: "Form color mode" })
  ).toHaveCount(0)
  await context.close()
})
