import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  ensureSodiumReady: vi.fn(),
  deriveVaultSalt: vi.fn(),
  deriveUnlockKey: vi.fn(),
  deriveAuthVerifier: vi.fn(),
  unwrapAccountKey: vi.fn(),
  createAccountSharingKey: vi.fn(),
  openSharingPrivateKey: vi.fn(),
  persistAccountKey: vi.fn(),
}))

vi.mock("../../lib/api", () => ({ apiFetch: mocks.apiFetch }))
vi.mock("../../lib/sodium-ready", () => ({
  ensureSodiumReady: mocks.ensureSodiumReady,
}))
vi.mock("../../lib/device-key", () => ({
  persistAccountKey: mocks.persistAccountKey,
  loadPersistedAccountKey: vi.fn(),
}))
vi.mock("@krypta/crypto", () => ({
  deriveVaultSalt: mocks.deriveVaultSalt,
  deriveUnlockKey: mocks.deriveUnlockKey,
  deriveAuthVerifier: mocks.deriveAuthVerifier,
  unwrapAccountKey: mocks.unwrapAccountKey,
  createAccountSharingKey: mocks.createAccountSharingKey,
  openSharingPrivateKey: mocks.openSharingPrivateKey,
}))

import { useAuthStore } from "../../lib/auth-store"
import { unlockVaultWithPassword } from "../../lib/vault-access"

describe("manual unlock with a null account sharing record", () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    vi.clearAllMocks()
    useAuthStore.getState().setSession({
      userId: "user-one",
      email: "user-one@example.com",
    })
    mocks.ensureSodiumReady.mockResolvedValue(undefined)
    mocks.deriveVaultSalt.mockReturnValue("derived-vault-salt")
    mocks.deriveUnlockKey.mockResolvedValue("verified-unlock-key")
    mocks.deriveAuthVerifier.mockReturnValue("derived-verifier")
    mocks.unwrapAccountKey.mockReturnValue("opened-account-key")
    mocks.persistAccountKey.mockResolvedValue(undefined)
    mocks.createAccountSharingKey.mockReturnValue({
      sharingPublicKey: "new-public",
      wrappedSharingPrivateKey: "new-wrapped-private",
      version: 1,
    })
    mocks.openSharingPrivateKey.mockReturnValue("opened-private")
  })

  it("proves the verifier first, then initializes the bound record before publishing", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({
        user_id: "user-one",
        wrapped_account_key: "sealed-account-key",
      })
      .mockResolvedValueOnce({
        user_id: "user-one",
        sharing_public_key: null,
        wrapped_sharing_private_key: null,
        sharing_key_version: null,
      })
      .mockResolvedValueOnce({})

    await unlockVaultWithPassword("correct password")

    expect(mocks.apiFetch.mock.calls).toEqual([
      [
        "/auth/reauthenticate",
        {
          method: "POST",
          body: JSON.stringify({ verifier: "derived-verifier" }),
        },
      ],
      ["/account/sharing-key"],
      [
        "/account/sharing-key",
        {
          method: "PUT",
          body: JSON.stringify({
            expected_user_id: "user-one",
            sharing_public_key: "new-public",
            wrapped_sharing_private_key: "new-wrapped-private",
            sharing_key_version: 1,
          }),
        },
      ],
    ])
    // The salt comes from the address, never from the server.
    expect(mocks.deriveVaultSalt).toHaveBeenCalledWith("user-one@example.com")
    expect(mocks.deriveUnlockKey).toHaveBeenCalledWith(
      "correct password",
      "derived-vault-salt"
    )
    expect(mocks.openSharingPrivateKey).toHaveBeenCalledWith(
      {
        sharingPublicKey: "new-public",
        wrappedSharingPrivateKey: "new-wrapped-private",
        version: 1,
      },
      "opened-account-key"
    )
    // The sharing keypair is bound to the account key, not the unlock key.
    expect(useAuthStore.getState().accountKey).toBe("opened-account-key")
  })
})
