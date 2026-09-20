import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiClientError } from "./api"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>()
  return { ...actual, apiFetch: mocks.apiFetch }
})

import {
  canOpenAdmin,
  deleteAccount,
  listEligibleOwnershipTransfers,
  listAdminAccounts,
  listAuditEvents,
  reactivateAccount,
  suspendAccount,
  transferAdminForm,
  updateAdminSettings,
} from "./admin"

describe("admin client seam", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("opens the admin UI only for an instance administrator with TOTP enabled", () => {
    expect(
      canOpenAdmin({
        instance_admin: true,
        totp_enabled: true,
        second_factor_verified: false,
      })
    ).toBe(false)
    expect(
      canOpenAdmin({
        instance_admin: true,
        totp_enabled: true,
        second_factor_verified: true,
      })
    ).toBe(true)
    expect(
      canOpenAdmin({
        instance_admin: true,
        totp_enabled: false,
        second_factor_verified: true,
      })
    ).toBe(false)
    expect(
      canOpenAdmin({
        instance_admin: false,
        totp_enabled: true,
        second_factor_verified: true,
      })
    ).toBe(false)
  })

  it("loads only server-projected shared forms and eligible editor membership IDs", async () => {
    mocks.apiFetch.mockResolvedValue({
      transfers: [
        {
          form_id: "0198e904-aa65-7bd1-a2d2-b734286d8f71",
          editor_member_ids: ["0198e904-aa65-7bd1-a2d2-b734286d8f72"],
        },
      ],
    })

    await expect(
      listEligibleOwnershipTransfers("0198e904-aa65-7bd1-a2d2-b734286d8f70")
    ).resolves.toEqual([
      {
        formId: "0198e904-aa65-7bd1-a2d2-b734286d8f71",
        editorMemberIds: ["0198e904-aa65-7bd1-a2d2-b734286d8f72"],
      },
    ])

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/admin/accounts/0198e904-aa65-7bd1-a2d2-b734286d8f70/eligible-transfers"
    )
  })

  it("lists account metadata through the admin namespace and preserves a complete cursor", async () => {
    mocks.apiFetch.mockResolvedValue({
      accounts: [],
      next_cursor: {
        id: "0198e904-aa65-7bd1-a2d2-b734286d8f80",
        created_at: "2026-08-27T12:00:00Z",
      },
    })

    await expect(
      listAdminAccounts({
        search: "0198e904",
        limit: 20,
        cursor: {
          id: "0198e904-aa65-7bd1-a2d2-b734286d8f70",
          createdAt: "2026-08-26T12:00:00Z",
        },
      })
    ).resolves.toEqual({
      accounts: [],
      nextCursor: {
        id: "0198e904-aa65-7bd1-a2d2-b734286d8f80",
        createdAt: "2026-08-27T12:00:00Z",
      },
    })

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/admin/accounts?search=0198e904&limit=20&cursor_id=0198e904-aa65-7bd1-a2d2-b734286d8f70&cursor_created_at=2026-08-26T12%3A00%3A00Z"
    )
  })

  it("omits incomplete pagination cursors instead of sending a malformed admin request", async () => {
    mocks.apiFetch.mockResolvedValue({ events: [], next_cursor: null })

    await listAuditEvents({
      action: "account_suspended",
      cursor: { id: "only-an-id", createdAt: "" },
    })

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/admin/audit?action=account_suspended"
    )
  })

  it("sends fixed-schema admin mutations without content or credential fields", async () => {
    mocks.apiFetch.mockResolvedValue({})

    await updateAdminSettings({
      registrationEnabled: false,
      defaultMaxForms: 40,
      defaultMaxAttachmentBytes: 1048576,
      password: "not-an-admin-setting",
    } as never)
    await suspendAccount("0198e904-aa65-7bd1-a2d2-b734286d8f70")
    await reactivateAccount("0198e904-aa65-7bd1-a2d2-b734286d8f70")
    await transferAdminForm(
      "0198e904-aa65-7bd1-a2d2-b734286d8f71",
      "0198e904-aa65-7bd1-a2d2-b734286d8f72"
    )
    await deleteAccount(
      "0198e904-aa65-7bd1-a2d2-b734286d8f70",
      "one-time-receipt"
    )

    expect(mocks.apiFetch).toHaveBeenNthCalledWith(1, "/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        registration_enabled: false,
        default_max_forms: 40,
        default_max_attachment_bytes: 1048576,
      }),
    })
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(
      2,
      "/admin/accounts/0198e904-aa65-7bd1-a2d2-b734286d8f70/suspend",
      { method: "POST" }
    )
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(
      3,
      "/admin/accounts/0198e904-aa65-7bd1-a2d2-b734286d8f70/reactivate",
      { method: "POST" }
    )
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(
      4,
      "/admin/forms/0198e904-aa65-7bd1-a2d2-b734286d8f71/transfer",
      {
        method: "POST",
        body: JSON.stringify({
          member_id: "0198e904-aa65-7bd1-a2d2-b734286d8f72",
        }),
      }
    )
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(
      5,
      "/admin/accounts/0198e904-aa65-7bd1-a2d2-b734286d8f70",
      {
        method: "DELETE",
        body: JSON.stringify({ reauthentication_receipt: "one-time-receipt" }),
      }
    )
  })

  it("keeps generic API failures intact for the UI to announce", async () => {
    const failure = new ApiClientError("forbidden", "Request failed")
    mocks.apiFetch.mockRejectedValue(failure)

    await expect(listAdminAccounts()).rejects.toBe(failure)
  })
})
