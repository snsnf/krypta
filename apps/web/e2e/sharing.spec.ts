import type { Browser, BrowserContext, Page } from "@playwright/test"
import {
  acknowledgeRecoveryCode,
  createVerifiedAccount,
  expect,
  installIsolatedCorsRoute,
  invitationLinkFor,
  nextInvitationLinkFor,
  openInvitation,
  shareLinkFor,
  test,
  unlockAccount,
  verificationCodeFor,
  waitForInteractive,
  type SharedAccount,
} from "./fixtures"

const API_BASE =
  process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:8080/api/v1"

async function accountPage(
  browser: Browser,
  account: SharedAccount
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  await unlockAccount(page, account)
  return { context, page }
}

async function createForm(page: Page, title: string) {
  await page.getByRole("button", { name: /new form/i }).click()
  await page.waitForURL(/\/dashboard\/new/)
  await page.getByRole("textbox", { name: "Form title" }).fill(title)
  await page.getByRole("textbox", { name: "Question label" }).fill("Notes")
  await page.getByRole("button", { name: "Publish form" }).click()
  await page.waitForURL(/\/dashboard\/.+\?created=1/)
  const formId = new URL(page.url()).pathname.split("/").at(-1)
  const publicLink = shareLinkFor(page)
  if (!formId) throw new Error("Published form link was unavailable.")
  return { formId, publicLink }
}

async function openSharing(page: Page) {
  await page.getByRole("button", { name: "Share" }).click()
  const dialog = page.getByRole("dialog", { name: "Share form" })
  await expect(dialog).toBeVisible()
  return dialog
}

async function invite(page: Page, email: string, role: "editor" | "viewer") {
  const dialog = await openSharing(page)
  await dialog.getByLabel("Email address").fill(email)
  await dialog.locator("form select").selectOption(role)
  await dialog.getByRole("button", { name: "Invite" }).click()
  await expect(page.getByText("Invitation sent", { exact: true })).toBeVisible()
  return dialog
}

async function acceptReadyInvitation(page: Page, link: string) {
  await openInvitation(page, link)
  await expect(
    page.getByRole("heading", { name: "Form invitation" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Accept" }).click()
  await page.waitForURL(/\/dashboard\/[0-9a-f-]+$/)
}

async function expectReadDenied(
  context: BrowserContext,
  formId: string,
  attachmentId = "00000000-0000-7000-8000-000000000000"
) {
  for (const path of [
    `/forms/${formId}`,
    `/forms/${formId}/responses`,
    `/forms/${formId}/attachments/${attachmentId}`,
  ]) {
    expect((await context.request.get(`${API_BASE}${path}`)).status()).toBe(404)
  }
}

test("real Editor and delayed Viewer grants enforce lifecycle, conflicts, closure, transfer, and deletion", async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const owner = await createVerifiedAccount("collaboration-owner")
  const editor = await createVerifiedAccount("collaboration-editor")

  const editorSession = await accountPage(browser, editor)
  const ownerSession = await accountPage(browser, owner)
  const { formId, publicLink } = await createForm(
    ownerSession.page,
    "Collaboration form"
  )

  const respondentContext = await browser.newContext()
  const respondentPage = await respondentContext.newPage()
  respondentPage.setDefaultTimeout(10_000)
  await installIsolatedCorsRoute(respondentPage)
  await respondentPage.goto(publicLink)
  await respondentPage.getByLabel("Notes").fill("Encrypted response")
  await respondentPage.getByRole("button", { name: "Submit" }).click()
  await expect(respondentPage.getByText("Thanks!")).toBeVisible()
  await respondentContext.close()

  await invite(ownerSession.page, editor.email, "editor")
  const editorLink = await invitationLinkFor(editor.email)
  await ownerSession.context.close()

  await acceptReadyInvitation(editorSession.page, editorLink)
  const editorGrant = await editorSession.context.request.get(
    `${API_BASE}/forms/${formId}`
  )
  expect(editorGrant.status()).toBe(200)
  expect((await editorGrant.json()).data.key_scheme).toBe(
    "account_sealed_box_v1"
  )
  await expect(
    editorSession.page.getByRole("textbox", { name: "Form title" })
  ).toHaveValue("Collaboration form")
  await editorSession.page.getByRole("tab", { name: "Responses" }).click()
  await expect(editorSession.page.getByText("Encrypted response")).toBeVisible()
  await editorSession.page.getByRole("tab", { name: "Questions" }).click()
  await editorSession.page
    .getByRole("textbox", { name: "Form title" })
    .fill("Editor updated form")
  await editorSession.page.getByRole("button", { name: "Save changes" }).click()
  await expect(editorSession.page.getByText("Saving...")).toHaveCount(0)

  const ownerReloaded = await accountPage(browser, owner)
  await ownerReloaded.page.goto(`/dashboard/${formId}`)
  await expect(
    ownerReloaded.page.getByRole("textbox", { name: "Form title" })
  ).toHaveValue("Editor updated form")
  await editorSession.page.reload()
  await expect(
    editorSession.page.getByRole("textbox", { name: "Form title" })
  ).toHaveValue("Editor updated form")

  let editorPatchCount = 0
  editorSession.page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      new URL(request.url()).pathname.endsWith(`/forms/${formId}`)
    ) {
      editorPatchCount += 1
    }
  })
  await ownerReloaded.page
    .getByRole("textbox", { name: "Form title" })
    .fill("Owner saved version")
  await ownerReloaded.page.getByRole("button", { name: "Save changes" }).click()
  await expect(ownerReloaded.page.getByText("Saving...")).toHaveCount(0)
  await editorSession.page
    .getByRole("textbox", { name: "Form title" })
    .fill("Editor local draft")
  await editorSession.page.getByRole("button", { name: "Save changes" }).click()
  const conflict = editorSession.page.getByRole("dialog", {
    name: "This form changed elsewhere",
  })
  await expect(conflict).toBeVisible()
  await expect(
    conflict.getByRole("button", { name: "Keep editing" })
  ).toBeFocused()
  await expect(
    editorSession.page.locator('input[aria-label="Form title"]')
  ).toHaveValue("Editor local draft")
  await editorSession.page.waitForTimeout(250)
  expect(editorPatchCount).toBe(1)
  await conflict.getByRole("button", { name: "Keep editing" }).click()

  await ownerReloaded.page.getByRole("tab", { name: "Questions" }).click()
  const racingContext = await browser.newContext()
  const racingPage = await racingContext.newPage()
  racingPage.setDefaultTimeout(10_000)
  await installIsolatedCorsRoute(racingPage)
  await racingPage.goto(publicLink)
  await racingPage.getByLabel("Notes").fill("Racing response")
  let releaseSubmission!: () => void
  const submissionRelease = new Promise<void>((resolve) => {
    releaseSubmission = resolve
  })
  let requestReachedApi!: () => void
  const submissionStarted = new Promise<void>((resolve) => {
    requestReachedApi = resolve
  })
  let closedCode: unknown
  await racingPage.route(
    `${API_BASE}/forms/${formId}/responses`,
    async (route) => {
      requestReachedApi()
      await submissionRelease
      const response = await route.fetch()
      const body = await response.json()
      closedCode = body.error?.code
      await route.fulfill({
        response,
        json: body,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": new URL(
            process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"
          ).origin,
          "access-control-allow-credentials": "true",
        },
      })
    }
  )
  const submitRace = racingPage.getByRole("button", { name: "Submit" }).click()
  await submissionStarted
  await ownerReloaded.page.getByRole("tab", { name: "Settings" }).click()
  await Promise.all([
    ownerReloaded.page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname.endsWith(`/forms/${formId}`)
    ),
    ownerReloaded.page.getByLabel("Accept responses").click(),
  ])
  releaseSubmission()
  await submitRace
  await expect(
    racingPage.getByText("This form is not accepting responses")
  ).toBeVisible()
  expect(closedCode).toBe("form_closed")
  await racingContext.close()

  await ownerReloaded.page.getByRole("tab", { name: "Questions" }).click()
  const viewerEmail = `e2e-new-viewer-${Date.now()}@example.com`
  const viewerPassword = "correct horse battery staple"
  const viewerInviteDialog = await invite(
    ownerReloaded.page,
    viewerEmail,
    "viewer"
  )
  const viewerLink = await invitationLinkFor(viewerEmail)
  await ownerReloaded.page.keyboard.press("Escape")
  await expect(viewerInviteDialog).toBeHidden()

  const viewerContext = await browser.newContext()
  const viewerPage = await viewerContext.newPage()
  viewerPage.setDefaultTimeout(10_000)
  await installIsolatedCorsRoute(viewerPage)
  await openInvitation(viewerPage, viewerLink)
  await expect(
    viewerPage.getByRole("heading", { name: "Sign in to continue" })
  ).toBeVisible()
  await viewerPage.locator('a[href^="/signup?"]').click()
  await waitForInteractive(viewerPage)
  await viewerPage.getByLabel("Email").fill(viewerEmail)
  await viewerPage.getByLabel("Password").fill(viewerPassword)
  await viewerPage.getByRole("button", { name: "Sign up" }).click()
  await viewerPage.getByLabel("Verification code").waitFor()
  await viewerPage
    .getByLabel("Verification code")
    .fill(await verificationCodeFor(viewerEmail))
  await viewerPage.getByRole("button", { name: "Verify" }).click()
  await acknowledgeRecoveryCode(viewerPage)
  await expect(
    viewerPage.getByRole("heading", { name: "Form invitation" })
  ).toBeVisible()
  await viewerPage.getByRole("button", { name: "Accept" }).click()
  await expect(
    viewerPage.getByRole("heading", { name: "Invitation accepted" })
  ).toBeVisible()
  await expect(
    viewerPage.getByText("Secure access is being prepared")
  ).toBeVisible()
  await viewerPage.locator('a[href="/dashboard"]').click()
  await expect(
    viewerPage.getByText("Shared form: waiting for secure access")
  ).toBeVisible()

  const awaitingDialog = await openSharing(ownerReloaded.page)
  await expect(
    awaitingDialog.getByRole("heading", { name: "Awaiting secure access" })
  ).toBeVisible()
  await expect(
    awaitingDialog.getByText("Waiting for secure access")
  ).toBeVisible()
  await ownerReloaded.context.close()

  const ownerProvisioning = await accountPage(browser, owner)
  await expect(
    ownerProvisioning.page.getByRole("link", { name: /Owner saved version/ })
  ).toBeVisible()
  await expect
    .poll(async () =>
      (await viewerContext.request.get(`${API_BASE}/forms/${formId}`)).status()
    )
    .toBe(200)
  await viewerPage.goto(`/dashboard/${formId}`)
  await expect(viewerPage.getByText("Viewing form")).toBeVisible()
  await expect(viewerPage.getByText("Notes", { exact: true })).toBeVisible()
  await viewerPage.getByRole("tab", { name: "Responses" }).click()
  await expect(viewerPage.getByText("Encrypted response")).toBeVisible()
  await expect(viewerPage.getByRole("button", { name: "Share" })).toHaveCount(0)
  // A Viewer's Settings tab deliberately holds only the per-member
  // notification preference: that's a fact about the person, not a
  // permission over the form, so it isn't gated behind canEdit the way the
  // editing controls and the danger zone are.
  await viewerPage.getByRole("tab", { name: "Settings" }).click()
  await expect(
    viewerPage.getByRole("switch", {
      name: "Email me when responses arrive",
    })
  ).toBeVisible()
  await expect(
    viewerPage.getByRole("switch", { name: "Accept responses" })
  ).toHaveCount(0)
  await expect(
    viewerPage.getByRole("switch", { name: "Allow response editing" })
  ).toHaveCount(0)
  await expect(
    viewerPage.getByRole("button", { name: "Delete form" })
  ).toHaveCount(0)
  await expect(
    viewerPage.getByRole("button", { name: "Save changes" })
  ).toHaveCount(0)
  expect(
    (
      await viewerContext.request.patch(`${API_BASE}/forms/${formId}`, {
        data: { accepting_responses: true, expected_version: 1 },
      })
    ).status()
  ).toBe(404)
  expect(
    (
      await viewerContext.request.post(
        `${API_BASE}/forms/${formId}/invitations/recipient-key`,
        { data: { invited_email: "redacted@example.invalid" } }
      )
    ).status()
  ).toBe(404)
  expect(
    (
      await viewerContext.request.get(
        `${API_BASE}/forms/${formId}/collaboration`
      )
    ).status()
  ).toBe(404)
  expect(
    (await viewerContext.request.delete(`${API_BASE}/forms/${formId}`)).status()
  ).toBe(404)

  expect(
    (
      await viewerContext.request.delete(
        `${API_BASE}/forms/${formId}/members/me`
      )
    ).status()
  ).toBe(200)
  await viewerPage.goto("/dashboard")
  await expect(viewerPage.getByText("Owner saved version")).toHaveCount(0)
  await expectReadDenied(viewerContext, formId)

  await ownerProvisioning.page.goto(`/dashboard/${formId}`)
  const sharingDialog = await openSharing(ownerProvisioning.page)
  await sharingDialog.getByRole("button", { name: "Transfer" }).click()
  const transferDialog = ownerProvisioning.page.getByRole("dialog", {
    name: "Transfer ownership?",
  })
  await expect(transferDialog).toContainText(
    "You will become an Editor and will no longer manage sharing."
  )
  await expect(
    transferDialog.getByRole("button", { name: "Cancel" })
  ).toBeFocused()
  await transferDialog
    .getByRole("button", { name: "Transfer ownership" })
    .click()
  await expect(
    ownerProvisioning.page.getByRole("button", { name: "Share" })
  ).toHaveCount(0)
  await ownerProvisioning.page.getByRole("tab", { name: "Settings" }).click()
  await expect(
    ownerProvisioning.page.getByRole("button", { name: "Delete form" })
  ).toHaveCount(0)

  await editorSession.page.reload()
  await expect(
    editorSession.page.getByRole("button", { name: "Share" })
  ).toBeVisible()
  await editorSession.page.getByRole("tab", { name: "Settings" }).click()
  await editorSession.page.getByLabel("Type DELETE to confirm").fill("DELETE")
  await editorSession.page.getByRole("button", { name: "Delete form" }).click()
  await editorSession.page.waitForURL(/\/dashboard$/)
  await ownerProvisioning.page.reload()
  await expect(
    ownerProvisioning.page.getByText("This form is no longer available")
  ).toBeVisible()

  await ownerProvisioning.context.close()
  await editorSession.context.close()
  await viewerContext.close()
})

test("resend, revoke, and removal use real links with safe reduced-motion confirmations", async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const owner = await createVerifiedAccount("invitation-owner")
  const recipient = await createVerifiedAccount("invitation-recipient")
  const ownerSession = await accountPage(browser, owner)
  const recipientSession = await accountPage(browser, recipient)
  const { formId } = await createForm(ownerSession.page, "Invitation lifecycle")

  await invite(ownerSession.page, recipient.email, "editor")
  const oldLink = await invitationLinkFor(recipient.email)
  const pendingSection = ownerSession.page.getByRole("region", {
    name: "Pending invitations",
  })
  await pendingSection.getByRole("button", { name: "Resend" }).click()
  await expect(
    ownerSession.page.getByText("Invitation sent", { exact: true })
  ).toBeVisible()
  const newestLink = await nextInvitationLinkFor(recipient.email, oldLink)

  await openInvitation(recipientSession.page, oldLink)
  await expect(
    recipientSession.page.getByRole("heading", {
      name: "Invitation unavailable",
    })
  ).toBeVisible()
  const rotatedLinkPage = await recipientSession.context.newPage()
  rotatedLinkPage.setDefaultTimeout(10_000)
  await installIsolatedCorsRoute(rotatedLinkPage)
  await acceptReadyInvitation(rotatedLinkPage, newestLink)

  await ownerSession.page.emulateMedia({ reducedMotion: "reduce" })
  await ownerSession.page.goto(`/dashboard/${formId}`)
  const activeDialog = await openSharing(ownerSession.page)
  await activeDialog.getByRole("button", { name: "Remove" }).click()
  const removalDialog = ownerSession.page.getByRole("dialog", {
    name: "Remove collaborator?",
  })
  await expect(
    removalDialog.getByRole("button", { name: "Cancel" })
  ).toBeFocused()
  await expect(removalDialog).toContainText("They will lose future access.")
  expect(
    await removalDialog.evaluate((element) => getComputedStyle(element).scale)
  ).toBe("1")
  expect(
    await removalDialog.evaluate((element) =>
      getComputedStyle(element).transitionProperty.includes("scale")
    )
  ).toBe(false)
  await removalDialog.getByRole("button", { name: "Remove" }).click()
  await expect(
    ownerSession.page.getByText("Collaborator removed", { exact: true })
  ).toBeVisible()
  await expectReadDenied(recipientSession.context, formId)

  await ownerSession.page.keyboard.press("Escape")
  const revokedEmail = `e2e-revoked-${Date.now()}@example.com`
  await invite(ownerSession.page, revokedEmail, "viewer")
  const revokedLink = await invitationLinkFor(revokedEmail)
  const revokeSection = ownerSession.page.getByRole("region", {
    name: "Pending invitations",
  })
  await revokeSection.getByRole("button", { name: "Revoke" }).click()
  const revokeDialog = ownerSession.page.getByRole("dialog", {
    name: "Revoke invitation?",
  })
  await expect(
    revokeDialog.getByRole("button", { name: "Cancel" })
  ).toBeFocused()
  expect(
    await revokeDialog.evaluate((element) => getComputedStyle(element).scale)
  ).toBe("1")
  await revokeDialog.getByRole("button", { name: "Revoke" }).click()

  const revokedContext = await browser.newContext()
  const revokedPage = await revokedContext.newPage()
  revokedPage.setDefaultTimeout(10_000)
  await installIsolatedCorsRoute(revokedPage)
  await openInvitation(revokedPage, revokedLink)
  await expect(
    revokedPage.getByRole("heading", { name: "Invitation unavailable" })
  ).toBeVisible()

  await revokedContext.close()
  await recipientSession.context.close()
  await ownerSession.context.close()
})
