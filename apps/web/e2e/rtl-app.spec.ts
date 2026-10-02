import { expect, test } from "./fixtures"

test("the entry screens switch to Arabic, right to left, and back", async ({
  page,
}) => {
  await page.goto("/login")
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible()

  await page.getByRole("button", { name: /Language: العربية/ }).click()
  const html = page.locator("html")
  await expect(html).toHaveAttribute("lang", "ar")
  await expect(html).toHaveAttribute("dir", "rtl")
  const heading = page.getByRole("heading", { name: "تسجيل الدخول" })
  await expect(heading).toBeVisible()
  await expect(heading).toHaveCSS("font-family", /Noto Sans Arabic/)
  // Credentials stay left to right on an Arabic page.
  await expect(page.getByLabel("البريد الإلكتروني")).toHaveAttribute("dir", "ltr")

  await page.getByRole("button", { name: /اللغة: English/ }).click()
  await expect(html).toHaveAttribute("lang", "en")
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible()
})

test("a browser that prefers Arabic gets Arabic with no cookie", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "ar-SA" })
  const page = await context.newPage()
  await page.goto("/login")
  await expect(page.locator("html")).toHaveAttribute("lang", "ar")
  await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible()
  const cookies = await context.cookies()
  expect(cookies.some((cookie) => cookie.name === "krypta-locale")).toBe(false)
  await context.close()
})
