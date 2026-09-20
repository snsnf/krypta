import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  restoreVaultForDashboard: vi.fn(),
}))

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react")
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => effect(),
  }
})

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))

vi.mock("../lib/auth-store", () => ({
  useAuthStore: (selector: (state: { accountKey: null }) => unknown) =>
    selector({ accountKey: null }),
}))

vi.mock("../lib/vault-access", () => ({
  restoreVaultForDashboard: mocks.restoreVaultForDashboard,
}))

import { useEnsureUnlocked } from "./use-ensure-unlocked"

describe("useEnsureUnlocked navigation gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps dashboard gated and client-navigates to passwordless retry", async () => {
    mocks.restoreVaultForDashboard.mockResolvedValueOnce("retry")

    useEnsureUnlocked()
    await vi.waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/unlock?vault=retry")
    })
  })

  it("routes an invalid session to login", async () => {
    mocks.restoreVaultForDashboard.mockRejectedValueOnce(new Error("expired"))

    useEnsureUnlocked()
    await vi.waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/login")
    })
  })

  it("does not navigate when an older restore flow reports a user switch", async () => {
    mocks.restoreVaultForDashboard.mockResolvedValueOnce("stale")

    useEnsureUnlocked()
    await vi.waitFor(() => {
      expect(mocks.restoreVaultForDashboard).toHaveBeenCalledTimes(1)
    })
    await Promise.resolve()

    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
