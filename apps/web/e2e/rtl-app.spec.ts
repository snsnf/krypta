import { expect, test, unlock } from "./fixtures"

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

test("the signed-in header switches language, fits a phone, and a form page keeps its own language", async ({
  page,
  sharedAccount,
}) => {
  await page.context().addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, sharedAccount.password)
  await page.waitForURL(/\/dashboard/)

  // From sm up the globe menu sits beside the theme toggle.
  await page.getByRole("button", { name: "Language" }).click()
  await page.getByRole("menuitemradio", { name: "العربية" }).click()
  const html = page.locator("html")
  await expect(html).toHaveAttribute("lang", "ar")
  await expect(html).toHaveAttribute("dir", "rtl")
  await expect(page.getByRole("link", { name: "الحساب" })).toBeVisible()
  await expect(page.getByRole("button", { name: "تسجيل الخروج" })).toBeVisible()

  // On a phone the header fits, and the language choice lives in the account
  // menu. Measured with every menu closed and unmounted: while one is open or
  // closing, Base UI's own 1px focus-guard spans add 1px of left overflow in
  // right-to-left only.
  await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(0)
  await page.setViewportSize({ width: 375, height: 700 })
  await expect(page.getByRole("button", { name: "قائمة الحساب" })).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await page.getByRole("button", { name: "قائمة الحساب" }).click()
  await expect(page.getByRole("menuitemradio", { name: "English" })).toBeVisible()

  await page.getByRole("menuitemradio", { name: "English" }).click()
  await expect(html).toHaveAttribute("lang", "en")
  await expect(html).toHaveAttribute("dir", "ltr")
  await page.getByRole("button", { name: "Account menu" }).click()
  await expect(page.getByRole("menuitem", { name: "Account" })).toBeVisible()
})

test("an Arabic browser still gets an English form error page, and an Arabic not-found page", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "ar-SA" })
  const page = await context.newPage()

  // A public form route ignores the app language: no key fragment, English text.
  await page.goto("/f/does-not-exist")
  await expect(page.locator("html")).toHaveAttribute("lang", "ar")
  await expect(page.getByRole("heading", { name: "This link is incomplete" })).toBeVisible()

  // Everything else follows it.
  await page.goto("/definitely-not-a-page")
  await expect(page.getByRole("heading", { name: "لا شيء هنا لفك ختمه." })).toBeVisible()
  await expect(page).toHaveTitle("الصفحة غير موجودة | krypta")
  await context.close()
})
