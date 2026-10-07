import { test, expect } from "@playwright/test"

const API_BASE = "http://localhost:8080/api/v1"
const accountId = "0198e904-aa65-7bd1-a2d2-b734286d8f70"
const formId = "0198e904-aa65-7bd1-a2d2-b734286d8f71"
const editorMemberId = "0198e904-aa65-7bd1-a2d2-b734286d8f72"

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
        status < 400 ? null : { code: "conflict", message: "Request failed" },
    }),
  }
}

test("admin keeps content APIs outside its request boundary and resets every consumed delete proof", async ({
  page,
}) => {
  const paths: string[] = []
  const deleteFailureStatuses = [409, 401, 500]
  let deleteAttempt = 0
  await page.emulateMedia({ reducedMotion: "reduce" })

  await page.route(`${API_BASE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "")
    paths.push(path)

    if (path === "/auth/me") {
      await route.fulfill(
        response({
          user_id: accountId,
          email: "administrator@example.com",
          instance_admin: true,
          totp_enabled: true,
          second_factor_verified: true,
        })
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
              suspended: false,
              totp_enabled: true,
              max_forms: null,
              max_attachment_bytes: null,
              forms_used: 1,
              attachment_bytes_used: 0,
            },
          ],
          next_cursor: null,
        })
      )
      return
    }
    if (path === `/admin/accounts/${accountId}/eligible-transfers`) {
      await route.fulfill(
        response({
          transfers: [{ form_id: formId, editor_member_ids: [editorMemberId] }],
        })
      )
      return
    }
    if (path === "/auth/reauthenticate") {
      await route.fulfill(response({ reauthentication_receipt: "receipt" }))
      return
    }
    if (path === `/admin/accounts/${accountId}`) {
      await route.fulfill(response({}, deleteFailureStatuses[deleteAttempt++]))
      return
    }

    throw new Error(`Unexpected admin-page request: ${path}`)
  })

  await page.goto("/admin")
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Shared form" })).toHaveText(
    formId
  )
  await expect(
    page.getByRole("combobox", { name: "Eligible editor" })
  ).toHaveText(editorMemberId)

  const deleteButton = page.getByRole("button", { name: "Delete" })
  await deleteButton.hover()
  await page.mouse.down()
  await expect(deleteButton).not.toHaveAttribute("data-pointer-pressed")
  await expect(
    deleteButton.evaluate((element) => getComputedStyle(element).transform)
  ).resolves.toBe("none")
  await page.mouse.up()
  for (
    let failureIndex = 0;
    failureIndex < deleteFailureStatuses.length;
    failureIndex++
  ) {
    await page.getByRole("textbox", { name: "Password" }).fill("password")
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page.getByLabel("Account suffix")).toBeVisible()
    await page.getByLabel("Account suffix").fill(accountId.slice(-8))
    await page.getByRole("button", { name: "Delete account" }).click()

    await expect(page.getByRole("textbox", { name: "Password" })).toBeVisible()
    await expect(page.getByLabel("Account suffix")).toHaveCount(0)
    await expect(
      page.getByRole("dialog", { name: "Verify password again" }).first()
    ).toBeVisible()
  }
  expect(deleteAttempt).toBe(3)
  expect(paths).toContain("/auth/me")
  expect(paths).toContain("/admin/accounts")
  expect(paths).toContain(`/admin/accounts/${accountId}/eligible-transfers`)
  expect(paths).toContain("/auth/reauthenticate")
  expect(paths).toContain(`/admin/accounts/${accountId}`)
})

test("admin transfer refresh replaces stale form and editor membership selections", async ({
  page,
}) => {
  const first = {
    formId: "0198e904-aa65-7bd1-a2d2-b734286d8f73",
    memberId: "0198e904-aa65-7bd1-a2d2-b734286d8f74",
  }
  const second = {
    formId: "0198e904-aa65-7bd1-a2d2-b734286d8f75",
    memberId: "0198e904-aa65-7bd1-a2d2-b734286d8f76",
  }
  const transfers: string[] = []
  let firstTransferComplete = false

  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace("/api/v1", "")
    if (path === "/auth/me") {
      await route.fulfill(
        response({
          user_id: accountId,
          email: "administrator@example.com",
          instance_admin: true,
          totp_enabled: true,
          second_factor_verified: true,
        })
      )
    } else if (path === "/admin/accounts") {
      await route.fulfill(
        response({
          accounts: [
            {
              id: accountId,
              created_at: "2026-08-28T00:00:00Z",
              instance_admin: false,
              suspended: false,
              totp_enabled: true,
              max_forms: null,
              max_attachment_bytes: null,
              forms_used: 1,
              attachment_bytes_used: 0,
            },
          ],
          next_cursor: null,
        })
      )
    } else if (path === `/admin/accounts/${accountId}/eligible-transfers`) {
      const current = firstTransferComplete ? second : first
      await route.fulfill(
        response({
          transfers: [
            { form_id: current.formId, editor_member_ids: [current.memberId] },
          ],
        })
      )
    } else if (path.startsWith("/admin/forms/")) {
      transfers.push(path)
      firstTransferComplete = true
      await route.fulfill(response({}))
    } else {
      throw new Error(`Unexpected transfer-page request: ${path}`)
    }
  })

  await page.goto("/admin")
  const transferButton = page.getByRole("button", { name: "Transfer" })
  await expect(transferButton).toBeEnabled()
  await transferButton.click()
  await expect(page.getByRole("combobox", { name: "Shared form" })).toHaveText(
    second.formId
  )
  await transferButton.click()
  expect(transfers).toEqual([
    `/admin/forms/${first.formId}/transfer`,
    `/admin/forms/${second.formId}/transfer`,
  ])
})
