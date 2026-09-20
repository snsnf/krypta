import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  unwrapAccountKey: vi.fn(),
  ensureAccountSharingKey: vi.fn(),
  persistAccountKey: vi.fn(),
}))

vi.mock("@krypta/crypto", () => ({
  deriveAuthVerifier: vi.fn(),
  deriveUnlockKey: vi.fn(),
  deriveVaultSalt: vi.fn(),
  unwrapAccountKey: mocks.unwrapAccountKey,
}))

vi.mock("./account-sharing-key", () => ({
  AccountSharingKeyError: class AccountSharingKeyError extends Error {},
  ensureAccountSharingKey: mocks.ensureAccountSharingKey,
}))

vi.mock("./device-key", () => ({
  loadPersistedAccountKey: vi.fn(),
  persistAccountKey: mocks.persistAccountKey,
}))

vi.mock("./sodium-ready", () => ({
  ensureSodiumReady: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("./api", () => ({
  apiFetch: vi.fn(),
}))

import {
  bootstrapVaultWithAccountKey,
  bootstrapVaultWithUnlockKey,
} from "./vault-access"
import { useAuthStore } from "./auth-store"

describe("vault bootstrap", () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    mocks.unwrapAccountKey.mockReset()
    mocks.ensureAccountSharingKey.mockReset()
    mocks.persistAccountKey.mockReset()
    mocks.ensureAccountSharingKey.mockResolvedValue({
      sharingPublicKey: "pub",
      wrappedSharingPrivateKey: "wrapped",
      sharingPrivateKey: "priv",
      version: 1 as const,
    })
    mocks.persistAccountKey.mockResolvedValue(undefined)
  })

  it("bootstrapVaultWithAccountKey reaches the same ready state as the password path, without an email or wrappedAccountKey", async () => {
    useAuthStore.getState().setSession({ userId: "user-one" })

    await bootstrapVaultWithAccountKey("user-one", "the-account-key")

    const state = useAuthStore.getState()
    expect(state.accountKey).toBe("the-account-key")
    expect(state.email).toBeNull()
    expect(state.wrappedAccountKey).toBeNull()
    expect(mocks.persistAccountKey).toHaveBeenCalledWith(
      "user-one",
      "the-account-key"
    )
    expect(mocks.ensureAccountSharingKey).toHaveBeenCalledWith({
      expectedUserId: "user-one",
      accountKey: "the-account-key",
    })
    expect(mocks.unwrapAccountKey).not.toHaveBeenCalled()
  })

  it("bootstrapVaultWithUnlockKey unwraps first and then runs the same tail", async () => {
    mocks.unwrapAccountKey.mockReturnValue("the-account-key")
    useAuthStore.getState().setSession({ userId: "user-one" })

    await bootstrapVaultWithUnlockKey(
      "user-one",
      "user@example.com",
      "the-unlock-key",
      "wrapped-account-key"
    )

    const state = useAuthStore.getState()
    expect(state.accountKey).toBe("the-account-key")
    expect(state.email).toBe("user@example.com")
    expect(state.wrappedAccountKey).toBe("wrapped-account-key")
    expect(mocks.unwrapAccountKey).toHaveBeenCalledWith(
      "wrapped-account-key",
      "the-unlock-key"
    )
    expect(mocks.persistAccountKey).toHaveBeenCalledWith(
      "user-one",
      "the-account-key"
    )
    expect(mocks.ensureAccountSharingKey).toHaveBeenCalledWith({
      expectedUserId: "user-one",
      accountKey: "the-account-key",
    })
  })

  it("bootstrapVaultWithAccountKey leaves an already-set password wrapper untouched for the same user", async () => {
    useAuthStore.getState().setSession({
      userId: "user-one",
      wrappedAccountKey: "existing-password-wrapper",
    })

    await bootstrapVaultWithAccountKey("user-one", "the-account-key")

    expect(useAuthStore.getState().wrappedAccountKey).toBe(
      "existing-password-wrapper"
    )
  })
})
