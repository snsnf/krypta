import { expect, test } from "@playwright/test"
import { expectNoEnglish } from "./leftover-english"

test("the landing page and /security read in Arabic, right to left, with no cookie", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "ar-SA" })
  const page = await context.newPage()

  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("lang", "ar")
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  await expect(
    page.getByRole("heading", { level: 1, name: "نماذج لا يقرؤها غيرك." })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "ما تحتفظ به خوادمنا فعلًا." })
  ).toBeVisible()
  await expectNoEnglish(page, "the landing page")

  await page.goto("/security")
  await expect(
    page.getByRole("heading", { level: 1, name: "الأمان" })
  ).toBeVisible()
  // Named algorithms and file names are written as they are everywhere.
  await expectNoEnglish(
    page,
    "the security page",
    /\b(TOTP|JavaScript|AGPL|Argon2id|MIME|WebAuthn PRF|Wing|ChaCha20|Poly1305|libsodium|SECURITY)\b/g
  )
  await expect(page).toHaveTitle("الأمان | krypta")

  // Reading it is not choosing it: no cookie until someone picks a language.
  expect(
    (await context.cookies()).some((c) => c.name === "krypta-locale")
  ).toBe(false)

  // The globe menu on the page switches it back, and the choice is remembered.
  await page.getByRole("button", { name: "اللغة" }).click()
  await page.getByRole("menuitemradio", { name: "English" }).click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(
    page.getByRole("heading", { level: 1, name: "Security" })
  ).toBeVisible()
  await context.close()
})
