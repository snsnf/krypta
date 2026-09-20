import { expect, test } from "@playwright/test"

function apiHeaders(origin = "http://localhost:3000") {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json",
  }
}

test("Strict Mode reuses one deferred invitation exchange", async ({
  page,
}) => {
  let continueCalls = 0
  let currentCalls = 0
  let releaseContinue!: () => void
  const continueGate = new Promise<void>((resolve) => {
    releaseContinue = resolve
  })

  await page.route("**/api/v1/invitations/**", async (route) => {
    const request = route.request()
    const headers = apiHeaders(request.headers().origin)
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers })
      return
    }

    const pathname = new URL(request.url()).pathname
    if (pathname.endsWith("/invitations/continue")) {
      continueCalls += 1
      await continueGate
      await route.fulfill({
        status: 200,
        headers,
        json: {
          success: true,
          data: { continued: true },
          meta: {},
          error: null,
        },
      })
      return
    }

    if (pathname.endsWith("/invitations/current")) {
      currentCalls += 1
      await route.fulfill({
        status: 200,
        headers,
        json: {
          success: true,
          data: {
            role: "viewer",
            status: "pending",
            masked_email: "i***@example.com",
            grant_ready: false,
          },
          meta: {},
          error: null,
        },
      })
      return
    }

    await route.abort()
  })

  await page.goto("/invitations/accept#token=strict-mode-token", {
    waitUntil: "domcontentloaded",
  })
  await expect.poll(() => continueCalls).toBe(1)
  await page.waitForTimeout(200)
  expect(continueCalls).toBe(1)
  expect(currentCalls).toBe(0)
  await expect(page).toHaveURL(/\/invitations\/accept$/)
  await expect(
    page.getByRole("heading", { name: "Form invitation" })
  ).not.toBeVisible()
  await expect(page.getByRole("button", { name: "Accept" })).not.toBeVisible()

  releaseContinue()
  await expect(
    page.getByRole("heading", { name: "Form invitation" })
  ).toBeVisible()
  expect(currentCalls).toBe(1)
})

test("unmount ignores a deferred exchange result after clearing the token", async ({
  page,
}) => {
  let continueCalls = 0
  let releaseContinue!: () => void
  const continueGate = new Promise<void>((resolve) => {
    releaseContinue = resolve
  })

  await page.route("**/api/v1/invitations/**", async (route) => {
    const request = route.request()
    const headers = apiHeaders(request.headers().origin)
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers })
      return
    }

    if (new URL(request.url()).pathname.endsWith("/invitations/continue")) {
      continueCalls += 1
      await continueGate
      await route
        .fulfill({
          status: 200,
          headers,
          json: {
            success: true,
            data: { continued: true },
            meta: {},
            error: null,
          },
        })
        .catch(() => {})
      return
    }

    await route.abort()
  })

  await page.goto("/invitations/accept#token=unmount-token", {
    waitUntil: "domcontentloaded",
  })
  await expect.poll(() => continueCalls).toBe(1)
  await expect(page).toHaveURL(/\/invitations\/accept$/)

  await page.getByRole("link", { name: "krypta" }).click()
  await expect(page).toHaveURL(/\/$/)
  releaseContinue()

  await expect(
    page.getByRole("heading", { name: /forms only you can read/i })
  ).toBeVisible()
  await expect(page).not.toHaveURL(/token=/)
  expect(continueCalls).toBe(1)
})
