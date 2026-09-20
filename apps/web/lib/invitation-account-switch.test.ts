import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  clearPersistedAccountKey: vi.fn(),
  clearAuth: vi.fn(),
  currentUserId: "current-user" as string | null,
}))

vi.mock("./api", () => ({ apiFetch: mocks.apiFetch }))
vi.mock("./device-key", () => ({
  clearPersistedAccountKey: mocks.clearPersistedAccountKey,
}))
vi.mock("./auth-store", () => ({
  useAuthStore: {
    getState: () => ({ userId: mocks.currentUserId, clear: mocks.clearAuth }),
  },
}))

import {
  createInvitationAccountSwitchProgress,
  switchInvitationAccount,
} from "./invitation-account-switch"

describe("switchInvitationAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.currentUserId = "current-user"
    mocks.apiFetch.mockResolvedValue({})
    mocks.clearPersistedAccountKey.mockResolvedValue(true)
  })

  it("clears only the current account wrapper and preserves invitation continuation", async () => {
    const navigate = vi.fn()

    const result = await switchInvitationAccount(
      createInvitationAccountSwitchProgress(),
      navigate
    )

    expect(result).toBe("complete")
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch).toHaveBeenCalledWith("/auth/logout", {
      method: "POST",
    })
    expect(
      mocks.apiFetch.mock.calls.some(([path]) =>
        String(path).startsWith("/invitations/")
      )
    ).toBe(false)
    expect(mocks.clearPersistedAccountKey).toHaveBeenCalledOnce()
    expect(mocks.clearPersistedAccountKey).toHaveBeenCalledWith("current-user")
    expect(mocks.clearPersistedAccountKey).not.toHaveBeenCalledWith("other-user")
    expect(mocks.clearAuth).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith("/login?next=%2Finvitations%2Faccept")
  })

  it("retries only wrapper deletion after server logout has succeeded", async () => {
    const progress = createInvitationAccountSwitchProgress()
    const navigate = vi.fn()
    mocks.clearPersistedAccountKey
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await expect(switchInvitationAccount(progress, navigate)).resolves.toBe(
      "failed"
    )
    await expect(switchInvitationAccount(progress, navigate)).resolves.toBe(
      "complete"
    )

    expect(mocks.apiFetch).toHaveBeenCalledOnce()
    expect(mocks.clearPersistedAccountKey).toHaveBeenCalledTimes(2)
    expect(mocks.clearPersistedAccountKey).toHaveBeenNthCalledWith(
      1,
      "current-user"
    )
    expect(mocks.clearPersistedAccountKey).toHaveBeenNthCalledWith(
      2,
      "current-user"
    )
    expect(mocks.clearAuth).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledOnce()
  })

  it("does not erase local keys when server logout has not proceeded", async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error("internal detail"))

    await expect(
      switchInvitationAccount(createInvitationAccountSwitchProgress(), vi.fn())
    ).resolves.toBe("failed")

    expect(mocks.clearPersistedAccountKey).not.toHaveBeenCalled()
    expect(mocks.clearAuth).not.toHaveBeenCalled()
  })
})
