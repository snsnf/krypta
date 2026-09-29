import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test as base, request } from "@playwright/test"
import type { Page } from "@playwright/test"
import sodium from "libsodium-wrappers-sumo"
import {
  deriveAuthVerifier,
  deriveRecoveryUnlockKey,
  deriveRecoveryVerifier,
  deriveUnlockKey,
  deriveVaultSalt,
  generateAccountKey,
  generateRecoveryCode,
  wrapAccountKey,
} from "@krypta/crypto"
import { invitationLinkFromContent } from "../lib/invitation-link"

const API_BASE =
  process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:8080/api/v1"
const MAILPIT_BASE =
  process.env.PLAYWRIGHT_MAILPIT_BASE ?? "http://localhost:8025"

/**
 * The most recent verification code mailed to `email`.
 *
 * Registration is two steps now, so any test that creates an account has to
 * read the code out of the dev mail catcher. Polls rather than sleeping a
 * fixed amount: delivery is fast but not instant.
 *
 * Response notifications now mail the same addresses these tests use, so the
 * newest message in the mailbox is not guaranteed to be a verification mail.
 * Each poll inspects messages newest-first and returns the first one that
 * carries a six-digit code, the same pattern `invitationLinkFor` uses below.
 */
export async function verificationCodeFor(email: string): Promise<string> {
  const api = await request.newContext()
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const res = await api.get(
        `${MAILPIT_BASE}/api/v1/search?query=to:${encodeURIComponent(email)}`
      )
      if (res.ok()) {
        const body = await res.json()
        for (const summary of body.messages ?? []) {
          if (typeof summary.ID !== "string") continue
          const messageRes = await api.get(
            `${MAILPIT_BASE}/api/v1/message/${encodeURIComponent(summary.ID)}`
          )
          if (!messageRes.ok()) continue
          const message = await messageRes.json()
          const code = /\b(\d{6})\b/.exec(message.Text ?? "")?.[1]
          if (code) return code
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(
      "No verification mail arrived. Is the mailpit container running?"
    )
  } finally {
    await api.dispose()
  }
}

/**
 * Waits for a code mailed to `email` that is not `previousCode`.
 *
 * Any flow that mails a second code to an address that already received one
 * (recovery, after the signup verification email) has two messages sitting in
 * the mailbox by the time it asks. `verificationCodeFor` just returns
 * whichever message it finds a code in first, so calling it right after
 * triggering the second mail can race ahead of delivery and return the old
 * code before the new one lands. This polls the same reader until it returns
 * something that isn't the code the caller already knows about.
 */
export async function nextVerificationCodeFor(
  email: string,
  previousCode: string
): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const code = await verificationCodeFor(email)
    if (code !== previousCode) return code
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("No new verification code arrived.")
}

/**
 * The newest invitation URL currently delivered to `email`.
 *
 * Search results can also contain verification mail, and a reused recipient
 * can have older invitations, so each poll inspects messages newest-first and
 * returns only the first exact fragment-bearing acceptance URL. Neither the
 * recipient nor the raw token is included in errors or console output.
 */
export async function invitationLinkFor(email: string): Promise<string> {
  const api = await request.newContext()
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const res = await api.get(
        `${MAILPIT_BASE}/api/v1/search?query=to:${encodeURIComponent(email)}`
      )
      if (res.ok()) {
        const body = await res.json()
        for (const summary of body.messages ?? []) {
          if (typeof summary.ID !== "string") continue
          const messageRes = await api.get(
            `${MAILPIT_BASE}/api/v1/message/${encodeURIComponent(summary.ID)}`
          )
          if (!messageRes.ok()) continue
          const message = await messageRes.json()
          const content = `${message.Text ?? ""}\n${message.HTML ?? ""}`
          const link = invitationLinkFromContent(content)
          if (link) return link
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(
      "No invitation mail arrived. Is the mailpit container running?"
    )
  } finally {
    await api.dispose()
  }
}

export async function nextInvitationLinkFor(
  email: string,
  previousLink: string
): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await invitationLinkFor(email)
    if (current !== previousLink) return current
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("No replacement invitation mail arrived.")
}

export async function openInvitation(page: Page, link: string) {
  const fragmentMarker = "#token="
  const fragmentIndex = link.indexOf(fragmentMarker)
  const fragment = fragmentIndex === -1 ? "" : link.slice(fragmentIndex)
  if (!/^#token=[A-Za-z0-9_-]+$/.test(fragment)) {
    throw new Error("Invitation mail did not contain a valid link.")
  }

  // Keep the secret out of Playwright navigation arguments: goto failures are
  // rendered in test output. The init script installs it before the invitation
  // page's application code runs, and that code immediately clears the hash.
  await page.goto("/invitations/accept")
  await page.addInitScript((invitationFragment) => {
    if (window.location.pathname === "/invitations/accept") {
      window.history.replaceState(
        null,
        "",
        `/invitations/accept${invitationFragment}`
      )
    }
  }, fragment)
  await page.goto("/invitations/accept")
}

/**
 * The value the browser sends to the auth endpoints.
 *
 * These fixtures call the API directly rather than driving the signup form, so
 * they have to reproduce the derivation the app does: the plaintext password is
 * never a credential the server accepts.
 */
export async function authVerifierFor(
  email: string,
  password: string
): Promise<string> {
  await sodium.ready
  return deriveAuthVerifier(await deriveUnlockKey(password, deriveVaultSalt(email)))
}

/**
 * A fresh account key and the wrapper signup has to send with it.
 *
 * Every form key is wrapped under the account key; the password-derived unlock
 * key wraps only this one value. These fixtures create accounts through the API
 * rather than the signup form, so they have to produce it the same way the
 * browser does: a wrapper the browser cannot open leaves an account that
 * authenticates and decrypts nothing.
 */
export async function accountKeyMaterialFor(
  email: string,
  password: string
): Promise<{
  accountKey: string
  recoveryCode: string
  wrappedAccountKeyPassword: string
  wrappedAccountKeyRecovery: string
  recoveryVerifier: string
}> {
  await sodium.ready
  const accountKey = generateAccountKey()
  const unlockKey = await deriveUnlockKey(password, deriveVaultSalt(email))
  // The second unlock method, generated here for the same reason the browser
  // generates it at signup: an account is never created with only one. The raw
  // code stays with the caller; only the verifier is ever sent.
  const recoveryCode = generateRecoveryCode()
  const recoveryUnlockKey = await deriveRecoveryUnlockKey(recoveryCode, email)
  return {
    accountKey,
    recoveryCode,
    wrappedAccountKeyPassword: wrapAccountKey(accountKey, unlockKey),
    wrappedAccountKeyRecovery: wrapAccountKey(accountKey, recoveryUnlockKey),
    recoveryVerifier: deriveRecoveryVerifier(recoveryUnlockKey),
  }
}

type RequestContext = Awaited<ReturnType<typeof request.newContext>>
type SessionCookies = Awaited<
  ReturnType<RequestContext["storageState"]>
>["cookies"]

export interface SharedAccount {
  email: string
  password: string
  /** The unwrapped account key, for tests that need to seal something to it. */
  accountKey: string
  /** The raw vault recovery code, which the server never sees. */
  recoveryCode: string
  sessionCookies: SessionCookies
}

const execFileAsync = promisify(execFile)

/**
 * Lifts the open-form ceiling for one e2e account.
 *
 * A developer with Stripe configured locally has billing enabled, which makes
 * the hosted free plan's 10-open-form cap apply to every account, including
 * this suite's. The suite needs twelve, so two tests fail at "Publish form"
 * with the button stuck on Saving, which reads as a product bug and is not.
 * `account_quotas` is the layer that wins over the plan, and it has no write
 * endpoint by design, so this goes in through psql the same way the docs say
 * an operator sets one.
 *
 * Keyed by email rather than id because the caller does not have the id, and
 * best-effort on purpose: a developer running the suite against a stack this
 * cannot reach still gets a working account, and only sees the cap if they
 * have Stripe configured.
 */
async function liftFormQuota(email: string): Promise<void> {
  const sql = `INSERT INTO account_quotas (user_id, max_forms)
               SELECT id, 1000 FROM users WHERE email = '${email}'
               ON CONFLICT (user_id) DO UPDATE SET max_forms = 1000`
  try {
    await execFileAsync("docker", [
      "compose",
      "-f",
      "../../infra/docker/docker-compose.dev.yml",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "krypta",
      "-d",
      "krypta",
      "-c",
      sql,
    ])
  } catch {
    // Nothing to do: the suite only needs this when billing is configured.
  }
}

export async function createVerifiedAccount(
  label: string
): Promise<SharedAccount> {
  const email = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
  const password = "correct horse battery staple"
  const api = await request.newContext()
  try {
    const registerRes = await api.post(`${API_BASE}/auth/register`, {
      data: { email, verifier: await authVerifierFor(email, password) },
    })
    if (!registerRes.ok()) {
      throw new Error(`Account registration failed (${registerRes.status()}).`)
    }
    const registerBody = await registerRes.json()
    const code = await verificationCodeFor(email)
    const {
      accountKey,
      recoveryCode,
      wrappedAccountKeyPassword,
      wrappedAccountKeyRecovery,
      recoveryVerifier,
    } = await accountKeyMaterialFor(email, password)
    const verifyRes = await api.post(`${API_BASE}/auth/verify-email`, {
      data: {
        pending_token: registerBody.data.pending_token,
        code,
        wrapped_account_key_password: wrappedAccountKeyPassword,
        wrapped_account_key_recovery: wrappedAccountKeyRecovery,
        recovery_verifier: recoveryVerifier,
      },
    })
    if (!verifyRes.ok()) {
      throw new Error(`Account verification failed (${verifyRes.status()}).`)
    }
    const { cookies } = await api.storageState()
    const sessionCookies = cookies.filter(
      (cookie) => cookie.name === "__Host-session"
    )
    if (sessionCookies.length !== 1) {
      throw new Error("Account verification did not create a session.")
    }
    await liftFormQuota(email)
    return { email, password, accountKey, recoveryCode, sessionCookies }
  } finally {
    await api.dispose()
  }
}

// Registers one account per worker via a direct API call (bypassing the UI signup form
// entirely) so tests that don't specifically need to exercise the signup/logout/IndexedDB-
// fallback mechanisms can log into a shared account instead of registering their own. This
// keeps the suite's total registration count under the server's 5/hour-per-IP limit even as
// more tests are added; see full-flow.spec.ts's comment at the top for the current budget.
export const test = base.extend<object, { sharedAccount: SharedAccount }>({
  sharedAccount: [
    async ({}, use) => {
      const email = `e2e-shared-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
      const password = "correct horse battery staple"
      const api = await request.newContext()
      const registerRes = await api.post(`${API_BASE}/auth/register`, {
        data: { email, verifier: await authVerifierFor(email, password) },
      })
      if (!registerRes.ok()) {
        throw new Error(
          `Shared e2e account registration failed (${registerRes.status()}).`
        )
      }
      const { data } = await registerRes.json()
      const code = await verificationCodeFor(email)
      const {
        accountKey,
        recoveryCode,
        wrappedAccountKeyPassword,
        wrappedAccountKeyRecovery,
        recoveryVerifier,
      } = await accountKeyMaterialFor(email, password)
      const verifyRes = await api.post(`${API_BASE}/auth/verify-email`, {
        data: {
          pending_token: data.pending_token,
          code,
          wrapped_account_key_password: wrappedAccountKeyPassword,
          wrapped_account_key_recovery: wrappedAccountKeyRecovery,
          recovery_verifier: recoveryVerifier,
        },
      })
      if (!verifyRes.ok()) {
        throw new Error(
          `Shared e2e account verification failed (${verifyRes.status()}).`
        )
      }
      const { cookies } = await api.storageState()
      const sessionCookies = cookies.filter(
        (cookie) => cookie.name === "__Host-session"
      )
      if (sessionCookies.length === 0) {
        throw new Error(
          "Shared e2e account registration did not create a session"
        )
      }
      await api.dispose()
      // This account owns a form in most tests in the suite, twelve in total,
      // which is what runs it into the free plan's ceiling on a machine with
      // Stripe configured.
      await liftFormQuota(email)
      await use({ email, password, accountKey, recoveryCode, sessionCookies })
    },
    { scope: "worker" },
  ],
})

export { expect } from "@playwright/test"

/**
 * Clicks through the recovery-code screen that now ends every UI signup.
 *
 * Returns the code it read, since this is the only moment it exists anywhere:
 * the server holds an Argon2 hash of a verifier derived from it, and the page
 * drops it on confirm.
 */
export async function acknowledgeRecoveryCode(page: Page): Promise<string> {
  const codeElement = page.getByTestId("recovery-code")
  await codeElement.waitFor()
  const recoveryCode = (await codeElement.textContent()) ?? ""
  await page.getByRole("checkbox").click()
  await page.getByRole("button", { name: "Continue" }).click()
  return recoveryCode.trim()
}

/**
 * Waits until the page can actually handle a submit.
 *
 * Every auth form derives a key in JavaScript, so its submit handler only
 * exists after React hydrates. Clicking earlier performs the form's native GET,
 * which reloads the same route and silently loses the attempt. Tests therefore
 * have to wait the way a person naturally does instead of clicking within
 * milliseconds of load.
 */
export async function waitForInteractive(page: Page) {
  await page.waitForLoadState("networkidle")
}

/**
 * Waits for every running CSS animation and transition to finish.
 *
 * `boundingBox()` reports where an element is drawn, so a test that measures
 * and then drives the mouse mid-animation drags between stale coordinates.
 * The builder's cards animate in (`question-in`) and slide into place after a
 * reorder, and on a slow CI runner both were still running when the reorder
 * test measured its handles, so its drag fell short of the midpoint it had to
 * cross. Infinite animations are skipped because they never finish, and an
 * animation cancelled while waiting is treated as done.
 */
export async function waitForAnimations(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined))
    )
  )
}

/**
 * Unlocks on /unlock, waiting for the app to be interactive first.
 *
 * The submit handler only exists once React hydrates. Clicking before then
 * performs the form's native GET, which reloads /unlock and silently loses the
 * attempt, so the test has to wait the way a person naturally does rather than
 * clicking within milliseconds of the load.
 */
export async function unlock(page: Page, password: string) {
  await page.waitForURL(/\/unlock/)
  await waitForInteractive(page)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Unlock" }).click()
  await page.waitForURL(/\/dashboard$/)
}

export async function installIsolatedCorsRoute(page: Page) {
  const isolatedApiBase = process.env.PLAYWRIGHT_API_BASE
  const isolatedWebBase = process.env.PLAYWRIGHT_BASE_URL
  if (!isolatedApiBase || !isolatedWebBase) return
  await page.route(`${isolatedApiBase}/**`, async (route) => {
    try {
      const response = await route.fetch()
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": new URL(isolatedWebBase).origin,
          "access-control-allow-credentials": "true",
        },
      })
    } catch (error) {
      // Next can leave a background request in flight while a test closes its
      // context. Playwright disposes that fetched response with the page; it is
      // teardown, not a failed request the test should surface.
      if (page.isClosed()) return
      throw error
    }
  })
}

/**
 * The public share link for the form currently open in the dashboard.
 *
 * Derived from the URL rather than read out of the page: the post-publish
 * banner that used to display it was removed, and deriving it keeps these
 * tests from being coupled to that UI at all. Requires the page to be on
 * /dashboard/{formId} with the key still in the fragment.
 */
export function shareLinkFor(page: Page): string {
  const url = new URL(page.url())
  const formId = url.pathname.split("/").filter(Boolean)[1]
  if (!formId) {
    throw new Error(
      `not on a form dashboard URL, so no form id to build a share link from: ${url.pathname}`
    )
  }
  if (!url.hash.startsWith("#key=")) {
    throw new Error(
      `no form key in the URL fragment to build a share link from: ${url.href}`
    )
  }
  return `${url.origin}/f/${formId}${url.hash}`
}

export async function unlockAccount(page: Page, account: SharedAccount) {
  await installIsolatedCorsRoute(page)
  await page.context().addCookies(account.sessionCookies)
  await page.goto("/unlock")
  await unlock(page, account.password)
}

/**
 * Leaves the New form gallery for a blank builder. /dashboard/new opens on
 * the template gallery, so every test that builds a form from scratch passes
 * through here first.
 */
export async function startBlankForm(page: Page) {
  await page.getByRole("button", { name: /blank form/i }).click()
  await page.getByRole("textbox", { name: "Form title" }).waitFor()
}
