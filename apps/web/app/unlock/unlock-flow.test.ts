import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  ensureAccountSharingKey: vi.fn(),
  ensureSodiumReady: vi.fn(),
  deriveVaultSalt: vi.fn(),
  deriveUnlockKey: vi.fn(),
  deriveAuthVerifier: vi.fn(),
  unwrapAccountKey: vi.fn(),
  persistAccountKey: vi.fn(),
  loadPersistedAccountKey: vi.fn(),
}))

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.apiFetch,
}))

vi.mock("../../lib/account-sharing-key", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/account-sharing-key")
  >("../../lib/account-sharing-key")
  return {
    ...actual,
    ensureAccountSharingKey: mocks.ensureAccountSharingKey,
  }
})

vi.mock("../../lib/sodium-ready", () => ({
  ensureSodiumReady: mocks.ensureSodiumReady,
}))

vi.mock("@krypta/crypto", () => ({
  deriveVaultSalt: mocks.deriveVaultSalt,
  deriveUnlockKey: mocks.deriveUnlockKey,
  deriveAuthVerifier: mocks.deriveAuthVerifier,
  unwrapAccountKey: mocks.unwrapAccountKey,
}))

vi.mock("../../lib/device-key", () => ({
  persistAccountKey: mocks.persistAccountKey,
  loadPersistedAccountKey: mocks.loadPersistedAccountKey,
}))

import {
  bootstrapVaultWithUnlockKey,
  restoreVaultForDashboard,
  retryPendingVault,
  unlockVaultWithPassword,
} from "../../lib/vault-access"
import { getPendingAccountKey, useAuthStore } from "../../lib/auth-store"

function signIn(userId = "user-one"): void {
  useAuthStore.getState().setSession({
    userId,
    email: `${userId}@example.com`,
  })
}

describe("unlock vault flow", () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    vi.clearAllMocks()
    signIn()
    mocks.ensureSodiumReady.mockResolvedValue(undefined)
    mocks.deriveVaultSalt.mockReturnValue("derived-vault-salt")
    mocks.deriveUnlockKey.mockResolvedValue("verified-unlock-key")
    mocks.deriveAuthVerifier.mockReturnValue("derived-verifier")
    mocks.unwrapAccountKey.mockReturnValue("opened-account-key")
    mocks.persistAccountKey.mockResolvedValue(undefined)
    mocks.ensureAccountSharingKey.mockResolvedValue({})
  })

  it("sends only the verifier, and writes nothing when the proof fails", async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error("unauthorized"))

    await expect(unlockVaultWithPassword("wrong password")).rejects.toThrow()

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch).toHaveBeenCalledWith("/auth/reauthenticate", {
      method: "POST",
      body: JSON.stringify({ verifier: "derived-verifier" }),
    })
    // The password itself must not appear anywhere in the request.
    expect(JSON.stringify(mocks.apiFetch.mock.calls)).not.toContain(
      "wrong password"
    )
    expect(mocks.persistAccountKey).not.toHaveBeenCalled()
    expect(mocks.ensureAccountSharingKey).not.toHaveBeenCalled()
    expect(useAuthStore.getState().accountKey).toBeNull()
    expect(getPendingAccountKey("user-one")).toBeNull()
  })

  it("derives from the email-derived salt and publishes only after bootstrap", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      user_id: "user-one",
      wrapped_account_key: "sealed-account-key",
    })
    let readyKeyDuringBootstrap: string | null | undefined
    mocks.ensureAccountSharingKey.mockImplementationOnce(async () => {
      readyKeyDuringBootstrap = useAuthStore.getState().accountKey
      expect(getPendingAccountKey("user-one")).toEqual({
        expectedUserId: "user-one",
        accountKey: "opened-account-key",
      })
      return {}
    })

    await unlockVaultWithPassword("correct password")

    expect(mocks.deriveVaultSalt).toHaveBeenCalledWith("user-one@example.com")
    expect(mocks.deriveUnlockKey).toHaveBeenCalledWith(
      "correct password",
      "derived-vault-salt"
    )
    // The unlock key opens the wrapper and nothing else; what is persisted and
    // published is the account key inside it.
    expect(mocks.unwrapAccountKey).toHaveBeenCalledWith(
      "sealed-account-key",
      "verified-unlock-key"
    )
    expect(mocks.persistAccountKey).toHaveBeenCalledWith(
      "user-one",
      "opened-account-key"
    )
    expect(readyKeyDuringBootstrap).toBeNull()
    expect(useAuthStore.getState().accountKey).toBe("opened-account-key")
    expect(useAuthStore.getState().wrappedAccountKey).toBe("sealed-account-key")
    expect(getPendingAccountKey("user-one")).toBeNull()
  })

  it("keeps a wrapper that will not open a purely local failure", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      user_id: "user-one",
      wrapped_account_key: "sealed-account-key",
    })
    mocks.unwrapAccountKey.mockImplementationOnce(() => {
      throw new Error("wrong secret key")
    })

    await expect(unlockVaultWithPassword("correct password")).rejects.toThrow(
      "Could not initialize the secure vault"
    )

    // Exactly one request: that is the proof. Nothing reports the failure back, or the
    // server would learn whether a wrapper opens.
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.persistAccountKey).not.toHaveBeenCalled()
    expect(mocks.ensureAccountSharingKey).not.toHaveBeenCalled()
    expect(useAuthStore.getState().accountKey).toBeNull()
    expect(getPendingAccountKey("user-one")).toBeNull()
  })

  it("refuses to unlock when the session carries no address to salt with", async () => {
    useAuthStore.getState().clear()
    useAuthStore.getState().setSession({ userId: "user-one" })

    await expect(unlockVaultWithPassword("correct password")).rejects.toThrow(
      "Could not initialize the secure vault"
    )
    expect(mocks.deriveUnlockKey).not.toHaveBeenCalled()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it("retains a silently restored key for passwordless retry while ready state stays gated", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      user_id: "user-one",
      email: "user-one@example.com",
      wrapped_account_key: "sealed-account-key",
    })
    mocks.loadPersistedAccountKey.mockResolvedValueOnce("restored-master")
    mocks.ensureAccountSharingKey
      .mockRejectedValueOnce(new Error("temporary bootstrap failure"))
      .mockResolvedValueOnce({})

    await expect(restoreVaultForDashboard()).resolves.toBe("retry")
    expect(useAuthStore.getState().accountKey).toBeNull()
    expect(getPendingAccountKey("user-one")).toEqual({
      expectedUserId: "user-one",
      accountKey: "restored-master",
    })

    await retryPendingVault("user-one")

    expect(mocks.ensureAccountSharingKey).toHaveBeenLastCalledWith({
      expectedUserId: "user-one",
      accountKey: "restored-master",
    })
    expect(useAuthStore.getState().accountKey).toBe("restored-master")
    expect(getPendingAccountKey("user-one")).toBeNull()
  })

  it("clears a failed silent restore when the authenticated user changes", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      user_id: "user-one",
      email: "user-one@example.com",
      wrapped_account_key: "sealed-account-key",
    })
    mocks.loadPersistedAccountKey.mockResolvedValueOnce("restored-master")
    mocks.ensureAccountSharingKey.mockRejectedValueOnce(new Error("temporary"))

    await expect(restoreVaultForDashboard()).resolves.toBe("retry")
    signIn("user-two")

    expect(getPendingAccountKey("user-one")).toBeNull()
    await expect(retryPendingVault("user-one")).rejects.toThrow(
      "Could not initialize the secure vault"
    )
  })

  it("discards a stale restored key when the user switches during device restore", async () => {
    let resolveRestore!: (value: string) => void
    mocks.apiFetch.mockResolvedValueOnce({
      user_id: "user-one",
      email: "user-one@example.com",
      wrapped_account_key: "sealed-account-key",
    })
    mocks.loadPersistedAccountKey.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveRestore = resolve
      })
    )

    const completion = restoreVaultForDashboard()
    await vi.waitFor(() => {
      expect(mocks.loadPersistedAccountKey).toHaveBeenCalledWith("user-one")
    })
    signIn("user-two")
    resolveRestore("user-one-restored-master")

    await expect(completion).resolves.toBe("stale")
    expect(mocks.ensureAccountSharingKey).not.toHaveBeenCalled()
    expect(getPendingAccountKey("user-one")).toBeNull()
    expect(getPendingAccountKey("user-two")).toBeNull()
    expect(useAuthStore.getState()).toMatchObject({
      userId: "user-two",
      accountKey: null,
    })
  })

  it("does not let a slow bootstrap publish a key for a superseded user", async () => {
    let resolvePersist!: () => void
    mocks.persistAccountKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePersist = resolve
      })
    )

    const completion = bootstrapVaultWithUnlockKey(
      "user-one",
      "user-one@example.com",
      "user-one-unlock-key",
      "user-one-sealed-account-key"
    )
    await vi.waitFor(() => {
      expect(mocks.persistAccountKey).toHaveBeenCalledTimes(1)
    })
    signIn("user-two")
    resolvePersist()

    await expect(completion).rejects.toThrow(
      "Could not initialize the secure vault"
    )
    expect(useAuthStore.getState()).toMatchObject({
      userId: "user-two",
      accountKey: null,
    })
    expect(mocks.ensureAccountSharingKey).not.toHaveBeenCalled()
  })
})
