import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getPendingAccountKey,
  installAuthClearHandler,
  promotePendingAccountKey,
  setPendingAccountKey,
  syncCurrentSessionTotpMetadata,
  useAuthStore,
} from "./auth-store"

function signIn(userId: string): void {
  useAuthStore.getState().setSession({
    userId,
    email: `${userId}@example.com`,
  })
}

describe("auth ephemeral material", () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    signIn("user-one")
  })

  it("keeps a retry key outside ready state and clears it on user switch", () => {
    const pending = {
      expectedUserId: "user-one",
      accountKey: "pending-master",
    }
    expect(setPendingAccountKey(pending)).toBe(true)

    expect(getPendingAccountKey("user-one")).toEqual(pending)
    expect(useAuthStore.getState().accountKey).toBeNull()

    signIn("user-two")

    expect(getPendingAccountKey("user-one")).toBeNull()
    expect(getPendingAccountKey("user-two")).toBeNull()
    expect(useAuthStore.getState().accountKey).toBeNull()
  })

  it("refuses stale pending placement and promotion explicitly", () => {
    const stale = {
      expectedUserId: "user-one",
      accountKey: "user-one-master",
    }
    signIn("user-two")

    expect(setPendingAccountKey(stale)).toBe(false)
    expect(promotePendingAccountKey(stale)).toBe(false)
    expect(getPendingAccountKey("user-one")).toBeNull()
    expect(useAuthStore.getState().accountKey).toBeNull()
  })

  it("replaces the HMR clear hook without retaining the stale handler", () => {
    const stale = vi.fn()
    const current = vi.fn()

    installAuthClearHandler(stale)
    installAuthClearHandler(current)
    expect(stale).toHaveBeenCalledTimes(1)

    useAuthStore.getState().clear()
    expect(stale).toHaveBeenCalledTimes(1)
    expect(current).toHaveBeenCalledTimes(1)
  })

  it("never treats a 2FA settings change as TOTP verification for this session", () => {
    useAuthStore.getState().setAdminMetadata({
      userId: "user-one",
      instanceAdmin: true,
      totpEnabled: true,
      totpVerified: true,
    })

    syncCurrentSessionTotpMetadata(false)
    expect(useAuthStore.getState()).toMatchObject({
      instanceAdmin: true,
      totpEnabled: false,
      totpVerified: false,
    })

    syncCurrentSessionTotpMetadata(true)
    expect(useAuthStore.getState()).toMatchObject({
      instanceAdmin: true,
      totpEnabled: true,
      totpVerified: false,
    })
  })
})
