import { test, expect } from "@playwright/test"
import { acknowledgeRecoveryCode, waitForInteractive } from "./fixtures"

const API_BASE = "http://localhost:8080/api/v1"
const initialAdminEmail = "initial-admin@example.test"
const adminId = "0198e904-aa65-7bd1-a2d2-b734286d8f70"
const accountId = "0198e904-aa65-7bd1-a2d2-b734286d8f71"
const ownedFormId = "0198e904-aa65-7bd1-a2d2-b734286d8f72"

function response(data: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify({
      success: status < 400,
      data,
      meta: {},
      error:
        status < 400 ? null : { code: "not_found", message: "Request failed" },
    }),
  }
}

test("a verified bootstrap admin completes TOTP login and manages only account metadata", async ({
  page,
}) => {
  let verified = false
  let signedIn = false
  let totpEnabled = false
  let secondFactorVerified = false
  let sharingKey: {
    sharingPublicKey: string
    wrappedSharingPrivateKey: string
  } | null = null
  let accountSuspended = false
  let observeAdminBoundary = false
  // Echoed back verbatim on every authenticated response, the way the API
  // does: the browser derives the unlock key locally and has to be able to
  // open exactly the wrapper it sent.
  //
  // Null only before signup has run. Every route that serves it is reachable
  // only once signed in, so it goes through `storedWrapper()` rather than being
  // served as null: the real API refuses to authenticate an account with no
  // wrapper at all, and `CurrentSession.wrapped_account_key` is typed to match.
  let wrappedAccountKey: string | null = null
  const storedWrapper = () => {
    if (wrappedAccountKey === null) {
      throw new Error("An authenticated route was served before signup.")
    }
    return wrappedAccountKey
  }
  const adminPaths: string[] = []

  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace("/api/v1", "")
    if (observeAdminBoundary) adminPaths.push(path)

    if (path === "/auth/me") {
      if (!signedIn) {
        await route.fulfill(response({}, 401))
        return
      }
      await route.fulfill(
        response({
          user_id: adminId,
          email: initialAdminEmail,
          instance_admin: verified,
          totp_enabled: totpEnabled,
          second_factor_verified: secondFactorVerified,
          wrapped_account_key: storedWrapper(),
        })
      )
      return
    }

    if (path === "/auth/register") {
      const body = request.postDataJSON()
      if (body.email !== initialAdminEmail) {
        throw new Error("Bootstrap registration used an unexpected email.")
      }
      await route.fulfill(
        response({ verification_required: true, pending_token: "verify-once" })
      )
      return
    }

    if (path === "/auth/verify-email") {
      const body = request.postDataJSON()
      if (body.pending_token !== "verify-once" || body.code !== "123456") {
        throw new Error(
          "Bootstrap verification did not redeem the expected code."
        )
      }
      if (typeof body.wrapped_account_key_password !== "string") {
        throw new Error("Signup did not send an account key wrapper.")
      }
      // No account may exist without a second unlock method, so signup has to
      // send the recovery wrapper and its verifier in the same request.
      if (
        typeof body.wrapped_account_key_recovery !== "string" ||
        typeof body.recovery_verifier !== "string"
      ) {
        throw new Error("Signup did not send recovery material.")
      }
      wrappedAccountKey = body.wrapped_account_key_password
      verified = true
      signedIn = true
      await route.fulfill(
        response({ user_id: adminId, wrapped_account_key: storedWrapper() })
      )
      return
    }

    if (path === "/account/sharing-key") {
      if (request.method() === "PUT") {
        const body = request.postDataJSON()
        sharingKey = {
          sharingPublicKey: body.sharing_public_key,
          wrappedSharingPrivateKey: body.wrapped_sharing_private_key,
        }
        await route.fulfill(response({}))
      } else {
        await route.fulfill(
          response({
            user_id: adminId,
            sharing_public_key: sharingKey?.sharingPublicKey ?? null,
            wrapped_sharing_private_key:
              sharingKey?.wrappedSharingPrivateKey ?? null,
            sharing_key_version: sharingKey ? 1 : null,
          })
        )
      }
      return
    }

    if (path === "/sharing/provisioning") {
      await route.fulfill(response({ items: [] }))
      return
    }

    if (path === "/forms") {
      await route.fulfill(response({ forms: [] }))
      return
    }

    if (path === "/auth/2fa/setup") {
      await route.fulfill(
        response({
          provisioning_uri:
            "otpauth://totp/Krypta:initial-admin@example.test?secret=TEST",
          qr_data_uri: "data:image/png;base64,iVBORw0KGgo=",
        })
      )
      return
    }

    // Turning a factor on first proves the password. The receipt it returns
    // is what the enable call below must carry.
    if (path === "/auth/reauthenticate") {
      await route.fulfill(
        response({
          user_id: "initial-admin",
          reauthentication_receipt: "enrolment-receipt",
          wrapped_account_key: null,
        })
      )
      return
    }

    if (path === "/auth/2fa/enable") {
      const body = request.postDataJSON()
      if (body.code !== "654321")
        throw new Error("Unexpected TOTP enrolment code.")
      if (body.reauthentication_receipt !== "enrolment-receipt")
        throw new Error("TOTP enrolment was sent without a password proof.")
      totpEnabled = true
      await route.fulfill(response({ recovery_codes: ["recovery-code"] }))
      return
    }

    // The settings page's Passkeys panel fetches this on mount. Stub it with
    // an empty list because this router throws on any unstubbed path.
    if (path === "/auth/passkeys") {
      await route.fulfill(response({ passkeys: [] }))
      return
    }

    // The settings page's Plan panel fetches this on mount, for the same
    // reason and with the same consequence. A 404 is the truest model: CI
    // runs the API with no Stripe configuration, so the billing router is
    // never mounted and the panel's "unavailable" branch is what really
    // renders here.
    if (path === "/billing/subscription") {
      await route.fulfill(response(null, 404))
      return
    }

    if (path === "/auth/logout") {
      signedIn = false
      secondFactorVerified = false
      await route.fulfill(response({}))
      return
    }

    if (path === "/auth/login") {
      const body = request.postDataJSON()
      if (body.email !== initialAdminEmail || !totpEnabled) {
        throw new Error("TOTP login did not follow bootstrap enrolment.")
      }
      await route.fulfill(
        response({ totp_required: true, pending_token: "totp-once" })
      )
      return
    }

    if (path === "/auth/2fa/verify") {
      const body = request.postDataJSON()
      if (body.pending_token !== "totp-once" || body.code !== "654321") {
        throw new Error("TOTP login did not redeem the expected code.")
      }
      signedIn = true
      secondFactorVerified = true
      await route.fulfill(
        response({ user_id: adminId, wrapped_account_key: storedWrapper() })
      )
      return
    }

    if (path === "/admin/accounts") {
      await route.fulfill(
        response({
          accounts: [
            {
              id: accountId,
              created_at: "2026-08-28T00:00:00Z",
              instance_admin: false,
              suspended: accountSuspended,
              totp_enabled: false,
              max_forms: null,
              max_attachment_bytes: null,
              forms_used: 1,
              attachment_bytes_used: 0,
              title_ciphertext: "ciphertext must not render",
              encrypted_form_data_key: "form key must not render",
            },
          ],
          next_cursor: null,
        })
      )
      return
    }

    if (path === `/admin/accounts/${accountId}/eligible-transfers`) {
      await route.fulfill(response({ transfers: [] }))
      return
    }

    if (path === `/admin/accounts/${accountId}/suspend`) {
      accountSuspended = true
      await route.fulfill(response({}))
      return
    }

    if (path === `/admin/accounts/${accountId}/reactivate`) {
      accountSuspended = false
      await route.fulfill(response({}))
      return
    }

    if (path === `/forms/${ownedFormId}/responses`) {
      if (!accountSuspended) {
        throw new Error("A suspended owner's public submission was accepted.")
      }
      await route.fulfill(response({}, 404))
      return
    }

    if (path === "/admin/audit") {
      await route.fulfill(
        response({
          events: [
            {
              id: "0198e904-aa65-7bd1-a2d2-b734286d8f73",
              actor_user_id: adminId,
              target_user_id: accountId,
              action: "account_suspended",
              result: "succeeded",
              created_at: "2026-08-28T00:00:00Z",
              email: "email must not render@example.test",
              content: "audit content must not render",
            },
          ],
          next_cursor: null,
        })
      )
      return
    }

    throw new Error(`Unexpected acceptance-test request: ${path}`)
  })

  // The configured email is first verified, which is the only time the
  // first-start bootstrap claim is made. This mock models server state only;
  // it writes no account, form, response, or audit data to a local instance.
  await page.goto("/signup")
  await waitForInteractive(page)
  await page.getByLabel("Email").fill(initialAdminEmail)
  await page.getByLabel("Password").fill("correct horse battery staple")
  await page.getByRole("button", { name: "Sign up" }).click()
  await page.getByLabel("Verification code").fill("123456")
  await page.getByRole("button", { name: "Verify" }).click()
  await acknowledgeRecoveryCode(page)
  await page.waitForURL(/\/dashboard$/)

  await page.goto("/dashboard/settings")
  await waitForInteractive(page)
  await page
    .getByRole("button", { name: "Set up two-factor authentication" })
    .click()
  await page.getByLabel("Code from your authenticator app").fill("654321")
  await page
    .getByLabel("Your password, to turn on two-factor authentication")
    .fill("correct horse battery staple")
  await page.getByRole("button", { name: "Turn on" }).click()
  await page.getByRole("button", { name: "I have saved them" }).click()

  await page.getByRole("button", { name: "Log out" }).click()
  await page.waitForURL(/\/login$/)
  await waitForInteractive(page)
  await page.getByLabel("Email").fill(initialAdminEmail)
  await page.getByLabel("Password").fill("correct horse battery staple")
  await page.getByRole("button", { name: "Log in" }).click()
  await page.getByLabel("Two-factor code").fill("654321")
  await page.getByRole("button", { name: "Verify" }).click()
  await page.waitForURL(/\/dashboard$/)
  await expect(page.getByRole("heading", { name: "Forms" })).toBeVisible()

  observeAdminBoundary = true
  await page.goto("/admin")
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible()
  await expect(page.getByText("ciphertext must not render")).toHaveCount(0)
  await expect(page.getByText("form key must not render")).toHaveCount(0)
  expect(adminPaths).not.toContain("/forms")
  expect(adminPaths).not.toContain("/attachments")
  expect(adminPaths).not.toContain("/sharing/provisioning")
  expect(adminPaths).not.toContain("/account/sharing-key")

  // Reduced motion is selected before keyboard opens the destructive dialog.
  await page.emulateMedia({ reducedMotion: "reduce" })
  const suspend = page.getByRole("button", { name: "Suspend" })
  await suspend.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("dialog", { name: "Suspend account?" })
  ).toBeVisible()
  const confirmSuspension = page.getByRole("button", {
    name: "Suspend account",
  })
  await confirmSuspension.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("button", { name: "Reactivate", exact: true })
  ).toBeVisible()

  const suspendedSubmission = await page.evaluate(
    async ({ apiBase, formId }) => {
      const response = await fetch(`${apiBase}/forms/${formId}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ciphertext: "test-ciphertext" }),
      })
      return { status: response.status, body: await response.json() }
    },
    { apiBase: API_BASE, formId: ownedFormId }
  )
  expect(suspendedSubmission.status).toBe(404)
  expect(suspendedSubmission.body.success).toBe(false)

  const reactivate = page.getByRole("button", {
    name: "Reactivate",
    exact: true,
  })
  await reactivate.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("dialog", { name: "Reactivate account?" })
  ).toBeVisible()
  const confirmReactivation = page.getByRole("button", {
    name: "Reactivate account",
  })
  await confirmReactivation.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("button", { name: "Suspend", exact: true })
  ).toBeVisible()

  await page.getByRole("link", { name: "Audit" }).click()
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible()
  await expect(
    page.getByText("email must not render@example.test")
  ).toHaveCount(0)
  await expect(page.getByText("audit content must not render")).toHaveCount(0)
})

test("a non-admin session is redirected before account metadata loads", async ({
  page,
}) => {
  const requestedPaths: string[] = []
  await page.route(`${API_BASE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "")
    requestedPaths.push(path)
    if (path === "/auth/me") {
      await route.fulfill(
        response({
          user_id: accountId,
          email: "member@example.test",
          instance_admin: false,
          totp_enabled: true,
          second_factor_verified: true,
        })
      )
      return
    }
    throw new Error(`Unexpected non-admin request: ${path}`)
  })

  await page.goto("/admin")
  await page.waitForURL(/\/(dashboard|unlock)$/)
  await expect(page.getByText("Instance metadata only")).toHaveCount(0)
  expect(requestedPaths).not.toContain("/admin/accounts")
  expect(requestedPaths).not.toContain("/admin/audit")
})
