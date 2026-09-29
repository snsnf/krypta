import { test as freshAccountTest, expect, type Page } from "@playwright/test"
import {
  acknowledgeRecoveryCode,
  test as sharedAccountTest,
  shareLinkFor,
  unlock,
  verificationCodeFor,
  waitForAnimations,
  waitForInteractive,
  startBlankForm,
} from "./fixtures"

// Registration is capped at 5/hour/IP server-side (apps/api/src/auth/routes.rs). Tests that
// exercise the signup/logout/IndexedDB-persistence mechanisms themselves need their own fresh
// account and use `freshAccountTest` (4 of them, below). Tests that just need to be logged in
// as *some* user reuse a single worker-scoped account via `sharedAccountTest` (./fixtures.ts),
// which registers once via a direct API call instead of through the UI. Budget: 4 fresh + 1
// shared = 5 registrations per full run, at the cap. If you add a test needing a fresh
// account, prefer switching another `sharedAccountTest` candidate first rather than pushing
// the suite over the limit. Each signup now costs one registration plus one verification
// (email/password gets a pending_token, not a session; the code from mailpit exchanges it
// for one via /auth/verify-email).

/**
 * Click a `multiple_choice` option the way a respondent does.
 *
 * The radio itself is `sr-only`, a real <input type="radio"> clipped to 1x1,
 * so `.check()` times out on actionability and `force: true` would bypass the
 * check entirely, keeping the test green even if the label stopped being the
 * click target. The wrapping <label> is what is actually visible and clickable.
 */
function chooseOption(page: Page, option: string) {
  return page
    .locator("label", {
      has: page.locator(`input[type="radio"][value="${option}"]`),
    })
    .click()
}

const test = freshAccountTest
const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:8080/api/v1"

test("register, create form, submit response, view decrypted response", async ({
  page,
  browser,
}) => {
  const email = `e2e-${Date.now()}@example.com`
  const password = "correct horse battery staple"

  await page.goto("/signup")
  await waitForInteractive(page)
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')

  await page.getByLabel("Verification code").waitFor()
  const code = await verificationCodeFor(email)
  await page.getByLabel("Verification code").fill(code)
  await page.getByRole("button", { name: "Verify" }).click()
  await acknowledgeRecoveryCode(page)

  // Navigate to /dashboard/new via the in-app link (client-side navigation), not page.goto():
  // the Master Key lives only in an in-memory Zustand store (never persisted), so a hard
  // navigation would wipe it and bounce to /unlock before the form can be created.
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
  await page.click('a[href="/dashboard/new"]')
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)
  await page.getByRole("textbox", { name: "Form title" }).fill("Feedback form")
  await page.getByRole("textbox", { name: "Question label" }).fill("How was your day?")
  await page.click('button:has-text("Publish form")')

  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const shareLinkText = shareLinkFor(page)
  expect(shareLinkText).toContain("/f/")

  const respondentContext = await browser.newContext()
  const respondentPage = await respondentContext.newPage()
  await respondentPage.goto(shareLinkText)
  await respondentPage.fill("input", "It was great!")
  await respondentPage.click('button:has-text("Submit")')
  await expect(respondentPage.getByText("Thanks!")).toBeVisible()
  await respondentContext.close()

  // A hard reload no longer wipes the Master Key: it's wrapped with a non-extractable,
  // per-device WebCrypto key stored in IndexedDB (see apps/web/lib/device-key.ts) and silently
  // restored by useEnsureUnlocked, so the page stays on the same URL and re-decrypts in place;
  // no /unlock detour needed.
  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await expect(page.getByText("It was great!")).toBeVisible({ timeout: 10_000 })
  expect(page.url()).toMatch(/\/dashboard\/.+/)
})

sharedAccountTest(
  "edit a published form's title and questions",
  async ({ page, browser, sharedAccount }) => {
  await page.goto("/login")
  await waitForInteractive(page)
  await page.fill('input[type="email"]', sharedAccount.email)
  await page.fill('input[type="password"]', sharedAccount.password)
  await page.click('button[type="submit"]')

  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
  await page.click('a[href="/dashboard/new"]')
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)
  await page.getByRole("textbox", { name: "Form title" }).fill("Original title")
  await page.getByRole("textbox", { name: "Question label" }).fill("First question")
  await page.click('button:has-text("Publish form")')

  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const shareLinkText = shareLinkFor(page)

  await page.getByRole("textbox", { name: "Form title" }).fill("Updated title")
  await page.getByRole("button", { name: "Add question" }).click()
  const questionLabels = page.getByRole("textbox", { name: "Question label" })
  await questionLabels.nth(1).fill("Second question")
  await page.click('button:has-text("Save changes")')

  await expect(page.getByText("Saving...")).toHaveCount(0)
  await expect(page.getByText("Updated title")).toBeVisible()

  const respondentContext = await browser.newContext()
  const respondentPage = await respondentContext.newPage()
  await respondentPage.goto(shareLinkText)
  await expect(respondentPage.getByText("Second question")).toBeVisible()
  await respondentPage.getByLabel("First question").fill("Still good")
  await respondentPage.getByLabel("Second question").fill("Brand new answer")
  await respondentPage.click('button:has-text("Submit")')
  await expect(respondentPage.getByText("Thanks!")).toBeVisible()
  await respondentContext.close()

  // A hard reload no longer wipes the Master Key (see the persistent-vault-unlock note above),
  // so reload the owner page back onto the response viewer and confirm the new question's
  // answer round-tripped: its client-generated UUID must line up from FormBuilder.addQuestion
  // through submission and back into the response viewer's r[q.id] cell.
  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await expect(page.getByText("Brand new answer")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText("Still good")).toBeVisible()
  }
)

sharedAccountTest(
  "new question types render, enforce required, and submit correctly",
  async ({ page, browser, sharedAccount }) => {
  await page.goto("/login")
  await waitForInteractive(page)
  await page.fill('input[type="email"]', sharedAccount.email)
  await page.fill('input[type="password"]', sharedAccount.password)
  await page.click('button[type="submit"]')

  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
  await page.click('a[href="/dashboard/new"]')
  await page.waitForURL(/\/dashboard\/new/)
  await startBlankForm(page)
  await page.getByRole("textbox", { name: "Form title" }).fill("Types test form")
  await page.getByRole("textbox", { name: "Question label" }).fill("Your name")

  await page.getByRole("button", { name: "Add question" }).click()
  const labels = page.getByRole("textbox", { name: "Question label" })
  await page.getByRole("combobox", { name: "Question type" }).nth(1).selectOption("checkboxes")
  await labels.nth(1).fill("Pick your favorites")
  const options = page.locator('input[placeholder^="Option "]')
  await options.nth(0).fill("Red")
  await page.click('button:has-text("+ Add option")')
  await options.nth(1).fill("Blue")

  await page.getByRole("button", { name: "Add question" }).click()
  await page.getByRole("combobox", { name: "Question type" }).nth(2).selectOption("email")
  await labels.nth(2).fill("Your email")
  // Mark the email question required through the interactive switch, not its hidden checkbox.
  await page.getByRole("switch", { name: "Required" }).nth(2).click()

  await page.click('button:has-text("Publish form")')
  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const shareLinkText = shareLinkFor(page)

  const respondentContext = await browser.newContext()
  const respondentPage = await respondentContext.newPage()
  await respondentPage.goto(shareLinkText)

  const submitButton = respondentPage.locator('button:has-text("Submit")')
  await expect(submitButton).toBeDisabled()

  await respondentPage.getByLabel("Your name").fill("Ada")
  await respondentPage.getByRole("checkbox", { name: "Red" }).check()
  await respondentPage.getByRole("checkbox", { name: "Blue" }).check()
  await respondentPage.getByLabel("Your email").fill("ada@example.com")

  await expect(submitButton).toBeEnabled()
  await submitButton.click()
  await expect(respondentPage.getByText("Thanks!")).toBeVisible()
  await respondentContext.close()

  await page.reload()
  await page.getByRole("tab", { name: "Responses" }).click()
  await page.getByRole("button", { name: "Individual" }).click()
  await expect(page.getByRole("table")).toBeVisible()
  await expect(page.getByText("Red, Blue")).toBeVisible({ timeout: 10_000 })
  }
)

sharedAccountTest(
  "file upload question round-trips through upload, submit, and decrypt",
  async ({ page, browser, sharedAccount }) => {
    await page.goto("/login")
  await waitForInteractive(page)
    await page.fill('input[type="email"]', sharedAccount.email)
    await page.fill('input[type="password"]', sharedAccount.password)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
    await page.click('a[href="/dashboard/new"]')
    await page.waitForURL(/\/dashboard\/new/)
    await startBlankForm(page)
    await page.getByRole("textbox", { name: "Form title" }).fill("File upload test form")
    await page.getByRole("textbox", { name: "Question label" }).fill("Attach a file")
    await page.getByRole("combobox", { name: "Question type" }).selectOption("file_upload")

    // The form builder only lets the owner define the question (label + type); it doesn't
    // render a file input of its own: file selection only happens on the public form page,
    // where a respondent actually answers the question. So there's nothing to upload here;
    // the owner just adds the file_upload question and publishes.
    const fileContent = "hello from the e2e test file\n"
    await page.click('button:has-text("Publish form")')
    await page.waitForURL(/\/dashboard\/.+\?created=1/)
    const shareLinkText = shareLinkFor(page)

    const respondentContext = await browser.newContext()
    const respondentPage = await respondentContext.newPage()
    await respondentPage.goto(shareLinkText)
    await respondentPage.setInputFiles('input[type="file"]', {
      name: "respondent-file.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(fileContent),
    })
    await expect(
      respondentPage.getByText("Uploaded: respondent-file.txt")
    ).toBeVisible({ timeout: 10_000 })
    await respondentPage.click('button:has-text("Submit")')
    await expect(respondentPage.getByText("Thanks!")).toBeVisible()
    await respondentContext.close()

    await page.reload()
    await page.getByRole("tab", { name: "Responses" }).click()
    await page.getByRole("button", { name: "Individual" }).click()
    await expect(page.getByRole("table")).toBeVisible()
    const downloadPromise = page.waitForEvent("download")
    await page.click('button:has-text("respondent-file.txt")')
    const download = await downloadPromise
    const downloadedPath = await download.path()
    const fs = await import("fs/promises")
    const downloadedContent = await fs.readFile(downloadedPath!, "utf-8")
    expect(downloadedContent).toBe(fileContent)
  }
)

test("falls back to /unlock when persisted-key storage is unavailable", async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    // Simulate IndexedDB being blocked/unavailable (e.g. some private-browsing modes) so the
    // silent-restore path fails and the app falls back to prompting for the password.
    Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true })
  })
  const page = await context.newPage()
  const email = `e2e-fallback-${Date.now()}@example.com`
  const password = "correct horse battery staple"

  await page.goto("/signup")
  await waitForInteractive(page)
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')

  await page.getByLabel("Verification code").waitFor()
  const code = await verificationCodeFor(email)
  await page.getByLabel("Verification code").fill(code)
  await page.getByRole("button", { name: "Verify" }).click()
  await acknowledgeRecoveryCode(page)
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })

  await page.reload()
  await unlock(page, password)

  await context.close()
})

test("logout clears the persisted key from IndexedDB", async ({ page }) => {
  const email = `e2e-logout-${Date.now()}@example.com`
  const password = "correct horse battery staple"

  await page.goto("/signup")
  await waitForInteractive(page)
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')

  await page.getByLabel("Verification code").waitFor()
  const code = await verificationCodeFor(email)
  await page.getByLabel("Verification code").fill(code)
  await page.getByRole("button", { name: "Verify" }).click()
  await acknowledgeRecoveryCode(page)
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })

  const userId = await page.evaluate(async (apiBase) => {
    const res = await fetch(`${apiBase}/auth/me`, { credentials: "include" })
    const body = await res.json()
    return body.data.user_id as string
  }, API_BASE)

  const hasDeviceKeyRecord = (uid: string) =>
    page.evaluate(
      (id) =>
        new Promise<boolean>((resolve) => {
          const req = indexedDB.open("krypta", 1)
          req.onsuccess = () => {
            const db = req.result
            const tx = db.transaction("device-keys", "readonly")
            const getReq = tx.objectStore("device-keys").get(id)
            getReq.onsuccess = () => resolve(getReq.result !== undefined)
            getReq.onerror = () => resolve(false)
          }
          req.onerror = () => resolve(false)
        }),
      uid
    )

  expect(await hasDeviceKeyRecord(userId)).toBe(true)

  await page.click('button:has-text("Log out")')
  await page.waitForURL(/\/login/, { timeout: 10_000 })

  expect(await hasDeviceKeyRecord(userId)).toBe(false)

  await page.goto("/dashboard")
  await page.waitForURL(/\/login/, { timeout: 10_000 })
})

test("falls back to /unlock when the persisted key record is tampered with", async ({
  page,
}) => {
  const email = `e2e-tamper-${Date.now()}@example.com`
  const password = "correct horse battery staple"

  await page.goto("/signup")
  await waitForInteractive(page)
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')

  await page.getByLabel("Verification code").waitFor()
  const code = await verificationCodeFor(email)
  await page.getByLabel("Verification code").fill(code)
  await page.getByRole("button", { name: "Verify" }).click()
  await acknowledgeRecoveryCode(page)
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })

  const userId = await page.evaluate(async (apiBase) => {
    const res = await fetch(`${apiBase}/auth/me`, { credentials: "include" })
    const body = await res.json()
    return body.data.user_id as string
  }, API_BASE)

  // Directly corrupt the persisted IndexedDB record so the AES-GCM tag no longer matches,
  // simulating tampering/corruption at rest. loadPersistedAccountKey must return null (not
  // throw) in this case, and the app must fall back to prompting for the password rather
  // than crashing or silently showing stale/wrong data.
  await page.evaluate(
    (id) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("krypta", 1)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction("device-keys", "readwrite")
          const store = tx.objectStore("device-keys")
          const getReq = store.get(id)
          getReq.onsuccess = () => {
            const record = getReq.result
            const bytes = new Uint8Array(record.wrappedAccountKey)
            bytes[0] = bytes[0] ^ 0xff
            const putReq = store.put(record)
            putReq.onsuccess = () => resolve()
            putReq.onerror = () => reject(putReq.error)
          }
          getReq.onerror = () => reject(getReq.error)
        }
        req.onerror = () => reject(req.error)
      }),
    userId
  )

  await page.reload()
  await page.waitForURL(/\/unlock/, { timeout: 10_000 })
})

sharedAccountTest(
  "a hidden question's answer is never submitted",
  async ({ page, browser, sharedAccount }) => {
    await page.goto("/login")
    await waitForInteractive(page)
    await page.fill('input[type="email"]', sharedAccount.email)
    await page.fill('input[type="password"]', sharedAccount.password)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
    await page.click('a[href="/dashboard/new"]')
    await page.waitForURL(/\/dashboard\/new/)
    await startBlankForm(page)
    await page.getByRole("textbox", { name: "Form title" }).fill("Conditional form")

    await page
      .getByRole("combobox", { name: "Question type" })
      .first()
      .selectOption("multiple_choice")
    await page.getByRole("textbox", { name: "Question label" }).first().fill("Delivery?")
    const options = page.locator('input[placeholder^="Option "]')
    await options.nth(0).fill("Yes")
    await page.click('button:has-text("+ Add option")')
    await options.nth(1).fill("No")

    await page.getByRole("button", { name: "Add question" }).click()
    const questionLabels = page.getByRole("textbox", { name: "Question label" })
    await questionLabels.nth(1).fill("Address")

    await page.click('button:has-text("+ Only show this if…")')
    await page.getByLabel("Condition question").selectOption({ label: "Delivery?" })
    await page.getByLabel("Condition operator").selectOption("is")
    await page.getByLabel("Condition value").selectOption("Yes")

    await page.click('button:has-text("Publish form")')
    await page.waitForURL(/\/dashboard\/.+\?created=1/)
    const shareLinkText = shareLinkFor(page)

    // First respondent: Delivery? = Yes, so Address is revealed and answered.
    const yesContext = await browser.newContext()
    const yesPage = await yesContext.newPage()
    await yesPage.goto(shareLinkText)
    await expect(yesPage.getByLabel("Address")).toHaveCount(0)
    await chooseOption(yesPage, "Yes")
    await expect(yesPage.getByLabel("Address")).toBeVisible()
    await yesPage.getByLabel("Address").fill("221B Baker Street")
    await yesPage.click('button:has-text("Submit")')
    await expect(yesPage.getByText("Thanks!")).toBeVisible()
    await yesContext.close()

    // Second respondent: answers Address, THEN flips the source so it hides.
    // This is the flow that actually exercises the submit-time filter: a
    // respondent who never revealed Address has no Address key in local state,
    // so deleting the filter would leave that case passing.
    const noContext = await browser.newContext()
    const noPage = await noContext.newPage()
    await noPage.goto(shareLinkText)
    await expect(noPage.getByLabel("Address")).toHaveCount(0)
    await chooseOption(noPage, "Yes")
    await expect(noPage.getByLabel("Address")).toBeVisible()
    await noPage.getByLabel("Address").fill("742 Evergreen Terrace")
    await chooseOption(noPage, "No")
    await expect(noPage.getByLabel("Address")).toHaveCount(0)

    // Answers are kept in local state while typing, so toggling a branch back
    // and forth does not destroy work.
    await chooseOption(noPage, "Yes")
    await expect(noPage.getByLabel("Address")).toHaveValue("742 Evergreen Terrace")

    await chooseOption(noPage, "No")
    await expect(noPage.getByLabel("Address")).toHaveCount(0)
    await noPage.click('button:has-text("Submit")')
    await expect(noPage.getByText("Thanks!")).toBeVisible()
    await noContext.close()

    await page.reload()
    await page.getByRole("tab", { name: "Responses" }).click()
    // Summary is the default view; individual answers only show up once switched.
    await page.getByRole("button", { name: "Individual" }).click()
    await expect(page.getByRole("table")).toBeVisible()

    const yesRow = page.getByRole("row").filter({ hasText: "Yes" })
    await expect(yesRow.locator("td").nth(1)).toHaveText("Yes")
    await expect(yesRow.locator("td").nth(2)).toHaveText("221B Baker Street", {
      timeout: 10_000,
    })

    const noRow = page.getByRole("row").filter({ hasText: "No" })
    await expect(noRow.locator("td").nth(1)).toHaveText("No")
    // Proves the submit-time filter ran: this respondent DID type an Address
    // before flipping the source, and the cell is empty rather than carrying
    // that stale "742 Evergreen Terrace".
    await expect(noRow.locator("td").nth(2)).toHaveText("")
  }
)

sharedAccountTest(
  "Focus layout advances past a hidden question without hitting the empty state",
  async ({ page, browser, sharedAccount }) => {
    await page.goto("/login")
    await waitForInteractive(page)
    await page.fill('input[type="email"]', sharedAccount.email)
    await page.fill('input[type="password"]', sharedAccount.password)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
    await page.click('a[href="/dashboard/new"]')
    await page.waitForURL(/\/dashboard\/new/)
    await startBlankForm(page)
    await page.getByRole("textbox", { name: "Form title" }).fill("Focus conditional form")

    await page
      .getByRole("combobox", { name: "Question type" })
      .first()
      .selectOption("multiple_choice")
    await page.getByRole("textbox", { name: "Question label" }).first().fill("Delivery?")
    const options = page.locator('input[placeholder^="Option "]')
    await options.nth(0).fill("Yes")
    await page.click('button:has-text("+ Add option")')
    await options.nth(1).fill("No")

    await page.getByRole("button", { name: "Add question" }).click()
    let questionLabels = page.getByRole("textbox", { name: "Question label" })
    await questionLabels.nth(1).fill("Address")

    await page.click('button:has-text("+ Only show this if…")')
    await page.getByLabel("Condition question").selectOption({ label: "Delivery?" })
    await page.getByLabel("Condition operator").selectOption("is")
    await page.getByLabel("Condition value").selectOption("Yes")

    // Add the unconditional final question only after the condition is wired up,
    // so there is exactly one "+ Only show this if…" button to click above.
    await page.getByRole("button", { name: "Add question" }).click()
    questionLabels = page.getByRole("textbox", { name: "Question label" })
    await questionLabels.nth(2).fill("Comments")

    // Switch the form to the Focus layout, where advancing walks the visible list.
    await page.getByRole("button", { name: "Focus layout" }).click()

    await page.click('button:has-text("Publish form")')
    await page.waitForURL(/\/dashboard\/.+\?created=1/)
    const shareLinkText = shareLinkFor(page)

    const respondentContext = await browser.newContext()
    const respondentPage = await respondentContext.newPage()
    await respondentPage.goto(shareLinkText)

    await expect(respondentPage.getByText("This form has no questions yet")).toHaveCount(0)
    await expect(respondentPage.getByLabel("Delivery?")).toBeVisible()

    await chooseOption(respondentPage, "No")
    await expect(respondentPage.getByText("This form has no questions yet")).toHaveCount(0)

    await respondentPage.click('button:has-text("Next")')

    // Address is skipped entirely: answering "No" drops it from the visible
    // list, so Next lands on the next visible question: the last one, hence a
    // Submit button rather than another Next.
    await expect(respondentPage.getByText("This form has no questions yet")).toHaveCount(0)
    await expect(respondentPage.getByLabel("Comments")).toBeVisible()
    await expect(respondentPage.getByRole("button", { name: "Submit", exact: true })).toBeVisible()

    await respondentPage.getByLabel("Comments").fill("All good")
    await respondentPage.click('button:has-text("Submit")')
    await expect(respondentPage.getByText("Thanks!")).toBeVisible()
    await expect(respondentPage.getByText("This form has no questions yet")).toHaveCount(0)

    await respondentContext.close()
  }
)

/**
 * The builder's warning for a condition whose source is no longer a usable
 * earlier question, copied verbatim from `components/form-builder.tsx`.
 */
const DANGLING_CONDITION_WARNING =
  "This condition points at a question that is no longer a usable source, either because it was deleted or because it is no longer a choice question, so it is ignored and this question always shows."

/**
 * Reads the current values of every "Question label" input in DOM order.
 *
 * `toHaveValues` only supports `<select multiple>`, not a locator matching
 * several plain `<input>`s, so the builder's question order is read back
 * with `inputValue()` on each match instead.
 */
async function questionLabelValues(page: Page): Promise<string[]> {
  const inputs = page.getByRole("textbox", { name: "Question label" })
  const count = await inputs.count()
  const values: string[] = []
  for (let i = 0; i < count; i++) {
    values.push(await inputs.nth(i).inputValue())
  }
  return values
}

sharedAccountTest(
  "reorder and duplicate questions in the builder, and the change reaches the public form",
  async ({ page, browser, sharedAccount }) => {
    await page.goto("/login")
    await waitForInteractive(page)
    await page.fill('input[type="email"]', sharedAccount.email)
    await page.fill('input[type="password"]', sharedAccount.password)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
    await page.click('a[href="/dashboard/new"]')
    await page.waitForURL(/\/dashboard\/new/)
    await startBlankForm(page)
    await page.getByRole("textbox", { name: "Form title" }).fill("Reorder test form")

    const questionLabels = page.getByRole("textbox", { name: "Question label" })
    await questionLabels.nth(0).fill("Alpha")
    await page.getByRole("button", { name: "Add question" }).click()
    await questionLabels.nth(1).fill("Bravo")
    await page.getByRole("button", { name: "Add question" }).click()
    await questionLabels.nth(2).fill("Charlie")

    expect(await questionLabelValues(page)).toEqual(["Alpha", "Bravo", "Charlie"])

    // Keyboard: focus the third question's handle and move it up one slot.
    await page.getByRole("button", { name: "Reorder question 3" }).focus()
    await page.keyboard.press("ArrowUp")
    await expect(async () => {
      expect(await questionLabelValues(page)).toEqual(["Alpha", "Charlie", "Bravo"])
    }).toPass()

    // Drag: move the first handle ("Alpha") below the second ("Charlie"), which
    // should swap them. The list reorders live during the drag (no pointer
    // capture, listeners on window), so the move needs at least two
    // intermediate steps to fire more than one pointermove, and, per the
    // brief, has to actually cross the second card's midpoint to register.
    //
    // The target is the second CARD's middle, not its handle's: the handle sits
    // on the card's top edge, so aiming at it never crosses the midpoint. The
    // test used to do exactly that and passed only when it measured the card
    // mid-slide, lower than it settles, which overshot by luck on a fast
    // machine and fell short on a slow one. Measuring once the animations have
    // finished and aiming at the card makes the drag land the same way on both.
    await waitForAnimations(page)
    const firstHandle = page.getByRole("button", { name: "Reorder question 1" })
    const secondCard = page.getByRole("button", { name: "Reorder question 2" }).locator("..")
    const firstBox = await firstHandle.boundingBox()
    const secondBox = await secondCard.boundingBox()
    if (!firstBox || !secondBox) {
      throw new Error("Reorder handle or card has no bounding box")
    }
    const startX = firstBox.x + firstBox.width / 2
    const startY = firstBox.y + firstBox.height / 2
    // Past the second card's middle, and far short of the third card's.
    const endY = secondBox.y + secondBox.height * 0.6

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX, startY + (endY - startY) / 2, { steps: 4 })
    await page.mouse.move(startX, endY, { steps: 4 })
    await page.mouse.up()

    await expect(async () => {
      expect(await questionLabelValues(page)).toEqual(["Charlie", "Alpha", "Bravo"])
    }).toPass()

    // Duplicate: the Duplicate control on the (now second) "Alpha" card.
    await page.getByRole("button", { name: "Duplicate question" }).nth(1).click()
    await expect(questionLabels).toHaveCount(4)
    expect(await questionLabelValues(page)).toEqual(["Charlie", "Alpha", "Alpha", "Bravo"])

    await page.click('button:has-text("Publish form")')
    await page.waitForURL(/\/dashboard\/.+\?created=1/)
    const shareLinkText = shareLinkFor(page)

    // Publish and open the public link: proves the reorder and duplicate
    // reached the encrypted schema, not just local builder state.
    const respondentContext = await browser.newContext()
    const respondentPage = await respondentContext.newPage()
    await respondentPage.goto(shareLinkText)

    const publicLabels = respondentPage.locator("label")
    await expect(publicLabels.filter({ hasText: "Charlie" })).toBeVisible()
    const orderedTexts = await publicLabels.allTextContents()
    const finalOrder = orderedTexts
      .map((text) => text.trim())
      .filter((text) => ["Charlie", "Bravo", "Alpha"].includes(text))
    expect(finalOrder).toEqual(["Charlie", "Alpha", "Alpha", "Bravo"])

    await respondentContext.close()
  }
)

sharedAccountTest(
  "reordering a source below its dependent surfaces the dangling-condition warning",
  async ({ page, sharedAccount }) => {
    await page.goto("/login")
    await waitForInteractive(page)
    await page.fill('input[type="email"]', sharedAccount.email)
    await page.fill('input[type="password"]', sharedAccount.password)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
    await page.click('a[href="/dashboard/new"]')
    await page.waitForURL(/\/dashboard\/new/)
    await startBlankForm(page)
    await page
      .getByRole("textbox", { name: "Form title" })
      .fill("Reorder breaks a condition")

    await page
      .getByRole("combobox", { name: "Question type" })
      .first()
      .selectOption("multiple_choice")
    await page.getByRole("textbox", { name: "Question label" }).first().fill("Delivery?")
    const options = page.locator('input[placeholder^="Option "]')
    await options.nth(0).fill("Yes")
    await page.click('button:has-text("+ Add option")')
    await options.nth(1).fill("No")

    await page.getByRole("button", { name: "Add question" }).click()
    const questionLabels = page.getByRole("textbox", { name: "Question label" })
    await questionLabels.nth(1).fill("Address")

    // Only the second question has an earlier choice question to point at, so
    // there is exactly one "+ Only show this if…" trigger on the page.
    await page.click('button:has-text("+ Only show this if…")')
    await page.getByLabel("Condition question").selectOption({ label: "Delivery?" })
    await page.getByLabel("Condition operator").selectOption("is")
    await page.getByLabel("Condition value").selectOption("Yes")

    const danglingWarning = page.getByText(DANGLING_CONDITION_WARNING)
    await expect(danglingWarning).toHaveCount(0)
    expect(await questionLabelValues(page)).toEqual(["Delivery?", "Address"])

    // Keyboard rather than drag: this case is about how reordering meets the
    // conditional-logic feature, not about drag geometry. Moving the source
    // below its dependent is what a condition can never survive: it may only
    // reference an earlier question.
    await page.getByRole("button", { name: "Reorder question 1" }).focus()
    await page.keyboard.press("ArrowDown")

    await expect(async () => {
      expect(await questionLabelValues(page)).toEqual(["Address", "Delivery?"])
    }).toPass()
    await expect(danglingWarning).toBeVisible()
  }
)

sharedAccountTest(
  "renaming the same form twice in a row does not report a phantom conflict",
  async ({ page, sharedAccount }) => {
    await page.goto("/login")
    await waitForInteractive(page)
    await page.fill('input[type="email"]', sharedAccount.email)
    await page.fill('input[type="password"]', sharedAccount.password)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
    await page.click('a[href="/dashboard/new"]')
    await page.waitForURL(/\/dashboard\/new/)
    await startBlankForm(page)
    await page
      .getByRole("textbox", { name: "Form title" })
      .fill("Rename me once")
    await page.getByRole("textbox", { name: "Question label" }).fill("Q1")
    await page.click('button:has-text("Publish form")')
    await page.waitForURL(/\/dashboard\/.+\?created=1/)

    async function rename(from: string, to: string) {
      await page.getByRole("button", { name: `Actions for ${from}` }).click()
      await page.getByRole("menuitem", { name: "Rename" }).click()
      await page.getByRole("textbox", { name: "Title" }).fill(to)
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await expect(page.getByText(to)).toBeVisible()
    }

    await page.goto("/dashboard")
    await expect(page.getByText("Rename me once")).toBeVisible()
    await rename("Rename me once", "Renamed once")

    // The second rename is the one that matters. A rename sends the version
    // the list was read at, so the version the first rename returned has to be
    // kept with the new title. Without that, this reports "changed elsewhere"
    // at a form nobody else has touched.
    await rename("Renamed once", "Renamed twice")
    await expect(page.getByText(/changed elsewhere/i)).toBeHidden()

    await page.reload()
    await expect(page.getByText("Renamed twice")).toBeVisible()
  }
)

sharedAccountTest(
  "a rename made against a title someone else has changed is refused, not applied",
  async ({ page, sharedAccount }) => {
    await page.goto("/login")
    await waitForInteractive(page)
    await page.fill('input[type="email"]', sharedAccount.email)
    await page.fill('input[type="password"]', sharedAccount.password)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 })
    await page.click('a[href="/dashboard/new"]')
    await page.waitForURL(/\/dashboard\/new/)
    await startBlankForm(page)
    await page.getByRole("textbox", { name: "Form title" }).fill("Contested form")
    await page.getByRole("textbox", { name: "Question label" }).fill("Q1")
    await page.click('button:has-text("Publish form")')
    await page.waitForURL(/\/dashboard\/.+\?created=1/)
    const formId = new URL(page.url()).pathname.split("/").pop() as string

    // The dashboard list is read here, at the version the form has right now.
    await page.goto("/dashboard")
    await expect(page.getByText("Contested form")).toBeVisible()

    /*
     * Someone else renames the form while this dashboard sits open. Sent
     * through the browser's own context so it carries the same session, which
     * is what a second device or a collaborator would look like from the
     * server's side. The stored value is opaque to the API, so any string
     * stands in for ciphertext here.
     */
    const apiBase =
      process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:8080/api/v1"
    const current = await page.request.get(`${apiBase}/forms/${formId}`)
    const version = (await current.json()).data.version as number
    const elsewhere = await page.request.patch(`${apiBase}/forms/${formId}`, {
      data: { title_ciphertext: "ct-from-elsewhere", expected_version: version },
    })
    expect(elsewhere.ok()).toBe(true)

    // This rename was typed against the title the list showed, which is now
    // stale, so it must be refused rather than silently overwrite the other
    // change. Re-reading the version just before writing would pick up that
    // other write's version and let this one clobber it with no conflict.
    await page
      .getByRole("button", { name: "Actions for Contested form" })
      .click()
    await page.getByRole("menuitem", { name: "Rename" }).click()
    await page.getByRole("textbox", { name: "Title" }).fill("Clobbered")
    await page.getByRole("button", { name: "Save", exact: true }).click()

    await expect(page.getByText(/changed elsewhere/i)).toBeVisible()
    // The typed title survives the refusal, so the work is not thrown away.
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Clobbered"
    )
  }
)
