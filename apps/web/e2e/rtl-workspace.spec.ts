import {
  expect,
  installIsolatedCorsRoute,
  shareLinkFor,
  test,
  waitForInteractive,
} from "./fixtures"
import { expectNoEnglish } from "./leftover-english"

/*
 * Every screen of the signed-in workspace in an Arabic browser, scanned for
 * English that was missed. A translated string is checked by the unit tests'
 * catalogue; this is the guard against the one nobody wrapped in t().
 */

test("the whole workspace reads in Arabic, right to left", async ({
  browser,
  sharedAccount,
}) => {
  const context = await browser.newContext({ locale: "ar-SA" })
  const page = await context.newPage()
  await installIsolatedCorsRoute(page)
  await context.addCookies(sharedAccount.sessionCookies)
  await page.goto("/unlock")
  // The unlock helper is worded in English; this browser prefers Arabic.
  await page.waitForURL(/\/unlock/)
  await waitForInteractive(page)
  await page.getByLabel("كلمة المرور").fill(sharedAccount.password)
  await page.getByRole("button", { name: "فتح", exact: true }).click()
  await page.waitForURL(/\/dashboard/)

  const html = page.locator("html")
  await expect(html).toHaveAttribute("lang", "ar")
  await expect(html).toHaveAttribute("dir", "rtl")
  await expect(page.getByRole("heading", { name: "النماذج" })).toBeVisible()
  await expectNoEnglish(page, "the dashboard")

  await page.getByRole("link", { name: "الحساب" }).click()
  await page.waitForURL(/\/dashboard\/settings/)
  await expect(
    page.getByRole("heading", { name: "الحساب", level: 1 })
  ).toBeVisible()
  await expectNoEnglish(page, "account settings")

  await page.goto("/dashboard/new")
  await expect(page.getByRole("heading", { name: "نموذج جديد" })).toBeVisible()
  await expectNoEnglish(page, "the template gallery")

  await page.getByRole("button", { name: /ملاحظات على الفعالية/ }).click()
  await expect(page.getByLabel("نص السؤال")).toHaveCount(4)
  await expectNoEnglish(page, "the builder")

  await page.getByRole("button", { name: "نشر النموذج" }).click()
  await page.waitForURL(/\/dashboard\/[^/]+\?created=1/)
  const shareLink = shareLinkFor(page)
  await expect(page.getByLabel("نص السؤال")).toHaveCount(4)
  await expectNoEnglish(page, "a form's questions tab")

  await page.getByRole("tab", { name: "الردود" }).click()
  await expect(page.getByText("لا توجد ردود بعد.")).toBeVisible()
  await expectNoEnglish(page, "the responses tab")

  await page.getByRole("tab", { name: "الإعدادات" }).click()
  await expect(page.getByText("قبول الردود", { exact: true })).toBeVisible()
  await expectNoEnglish(page, "the form settings tab")

  await page.getByRole("tab", { name: "الأسئلة" }).click()
  await page.getByRole("button", { name: "مشاركة" }).click()
  await expect(
    page.getByRole("heading", { name: "مشاركة النموذج" })
  ).toBeVisible()
  await expect(page.getByText("لا توجد دعوات معلّقة.")).toBeVisible()
  await expectNoEnglish(page, "the sharing dialog")
  await page.keyboard.press("Escape")

  // A form started from an Arabic template is an Arabic form for respondents.
  const respondent = await context.newPage()
  await respondent.goto(shareLink)
  const surface = respondent.getByTestId("form-theme-surface").first()
  await expect(surface).toHaveAttribute("lang", "ar")
  await expect(surface).toHaveAttribute("dir", "rtl")
  await context.close()
})
