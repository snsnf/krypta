import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  ensureSodiumReady: vi.fn(),
  createAccountSharingKey: vi.fn(),
  openSharingPrivateKey: vi.fn(),
}))

vi.mock("./api", () => ({
  apiFetch: mocks.apiFetch,
}))

vi.mock("./sodium-ready", () => ({
  ensureSodiumReady: mocks.ensureSodiumReady,
}))

vi.mock("@krypta/crypto", () => ({
  createAccountSharingKey: mocks.createAccountSharingKey,
  openSharingPrivateKey: mocks.openSharingPrivateKey,
}))

import { ensureAccountSharingKey } from "./account-sharing-key"
import { useAuthStore } from "./auth-store"

const accountKey = "master-key"
const userOneMaster = {
  expectedUserId: "user-one",
  accountKey,
}
const userTwoMaster = {
  expectedUserId: "user-two",
  accountKey: "user-two-master",
}
const emptyRecord = {
  user_id: "user-one",
  sharing_public_key: null,
  wrapped_sharing_private_key: null,
  sharing_key_version: null,
}
const storedRecord = {
  user_id: "user-one",
  sharing_public_key: "stored-public",
  wrapped_sharing_private_key: "stored-wrapped-private",
  sharing_key_version: 1 as const,
}

function signIn(userId: string): void {
  useAuthStore.getState().setSession({
    userId,
    email: `${userId}@example.com`,
  })
}

describe("ensureAccountSharingKey", () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    vi.clearAllMocks()
    mocks.ensureSodiumReady.mockResolvedValue(undefined)
    mocks.createAccountSharingKey.mockReturnValue({
      sharingPublicKey: "new-public",
      wrappedSharingPrivateKey: "new-wrapped-private",
      version: 1,
    })
    mocks.openSharingPrivateKey.mockReturnValue("opened-private")
    signIn("user-one")
  })

  it("creates and PUTs a key exactly once when concurrent calls find none", async () => {
    mocks.apiFetch.mockResolvedValueOnce(emptyRecord).mockResolvedValueOnce({})

    const [first, second] = await Promise.all([
      ensureAccountSharingKey(userOneMaster),
      ensureAccountSharingKey(userOneMaster),
    ])

    expect(first).toEqual({
      sharingPublicKey: "new-public",
      wrappedSharingPrivateKey: "new-wrapped-private",
      sharingPrivateKey: "opened-private",
      version: 1,
    })
    expect(second).toBe(first)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(1, "/account/sharing-key")
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(2, "/account/sharing-key", {
      method: "PUT",
      body: JSON.stringify({
        expected_user_id: "user-one",
        sharing_public_key: "new-public",
        wrapped_sharing_private_key: "new-wrapped-private",
        sharing_key_version: 1,
      }),
    })
    expect(mocks.createAccountSharingKey).toHaveBeenCalledTimes(1)
    expect(mocks.openSharingPrivateKey).toHaveBeenCalledWith(
      {
        sharingPublicKey: "new-public",
        wrappedSharingPrivateKey: "new-wrapped-private",
        version: 1,
      },
      accountKey
    )
  })

  it("waits for sodium before opening an existing key", async () => {
    mocks.apiFetch.mockResolvedValueOnce(storedRecord)

    await ensureAccountSharingKey(userOneMaster)

    expect(mocks.ensureSodiumReady).toHaveBeenCalledTimes(1)
    expect(mocks.ensureSodiumReady.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openSharingPrivateKey.mock.invocationCallOrder[0]
    )
  })

  it("clears cached material when the auth store is cleared", async () => {
    mocks.apiFetch.mockResolvedValueOnce(storedRecord).mockResolvedValueOnce({
      user_id: "user-one",
      sharing_public_key: "replacement-public",
      wrapped_sharing_private_key: "replacement-wrapped-private",
      sharing_key_version: 1,
    })
    mocks.openSharingPrivateKey
      .mockReturnValueOnce("first-private")
      .mockReturnValueOnce("replacement-private")

    const first = await ensureAccountSharingKey(userOneMaster)
    useAuthStore.getState().clear()
    signIn("user-one")
    const replacement = await ensureAccountSharingKey(userOneMaster)

    expect(first.sharingPrivateKey).toBe("first-private")
    expect(replacement.sharingPrivateKey).toBe("replacement-private")
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
  })

  it("does not reuse cached material for a different authenticated user", async () => {
    mocks.apiFetch.mockResolvedValueOnce(storedRecord).mockResolvedValueOnce({
      user_id: "user-two",
      sharing_public_key: "user-two-public",
      wrapped_sharing_private_key: "user-two-wrapped-private",
      sharing_key_version: 1,
    })
    mocks.openSharingPrivateKey
      .mockReturnValueOnce("user-one-private")
      .mockReturnValueOnce("user-two-private")

    await ensureAccountSharingKey(userOneMaster)
    signIn("user-two")
    const second = await ensureAccountSharingKey(userTwoMaster)

    expect(second).toMatchObject({
      sharingPublicKey: "user-two-public",
      sharingPrivateKey: "user-two-private",
    })
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
  })

  it("rejects an explicitly bound stale master before any sharing request", async () => {
    signIn("user-two")

    await expect(ensureAccountSharingKey(userOneMaster)).rejects.toThrow(
      "Could not initialize the secure vault"
    )

    expect(mocks.ensureSodiumReady).not.toHaveBeenCalled()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(mocks.createAccountSharingKey).not.toHaveBeenCalled()
    expect(mocks.openSharingPrivateKey).not.toHaveBeenCalled()
  })

  it("aborts after a GET user switch without generating or PUTting", async () => {
    let resolveGet!: (value: typeof emptyRecord) => void
    mocks.apiFetch.mockReturnValueOnce(
      new Promise<typeof emptyRecord>((resolve) => {
        resolveGet = resolve
      })
    )

    const completion = ensureAccountSharingKey(userOneMaster)
    await vi.waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    })
    signIn("user-two")
    resolveGet(emptyRecord)

    await expect(completion).rejects.toThrow(
      "Could not initialize the secure vault"
    )
    expect(mocks.createAccountSharingKey).not.toHaveBeenCalled()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
  })

  it("aborts before PUT when the user changes during key generation", async () => {
    mocks.apiFetch.mockResolvedValueOnce(emptyRecord)
    mocks.createAccountSharingKey.mockImplementationOnce(() => {
      signIn("user-two")
      return {
        sharingPublicKey: "new-public",
        wrappedSharingPrivateKey: "new-wrapped-private",
        version: 1,
      }
    })

    await expect(ensureAccountSharingKey(userOneMaster)).rejects.toThrow(
      "Could not initialize the secure vault"
    )

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.openSharingPrivateKey).not.toHaveBeenCalled()
  })

  it("cannot resolve or cache material after the user changes during PUT", async () => {
    let resolvePut!: (value: Record<string, never>) => void
    mocks.apiFetch.mockResolvedValueOnce(emptyRecord).mockReturnValueOnce(
      new Promise<Record<string, never>>((resolve) => {
        resolvePut = resolve
      })
    )

    const completion = ensureAccountSharingKey(userOneMaster)
    await vi.waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    })
    signIn("user-two")
    resolvePut({})

    await expect(completion).rejects.toThrow(
      "Could not initialize the secure vault"
    )
    expect(mocks.openSharingPrivateKey).not.toHaveBeenCalled()
  })

  it("checks identity again before resolving opened existing material", async () => {
    mocks.apiFetch.mockResolvedValueOnce(storedRecord)
    mocks.openSharingPrivateKey.mockImplementationOnce(() => {
      signIn("user-two")
      return "stale-opened-private"
    })

    await expect(ensureAccountSharingKey(userOneMaster)).rejects.toThrow(
      "Could not initialize the secure vault"
    )
  })

  it("GETs again after an ambiguous PUT failure before considering another key", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(emptyRecord)
      .mockRejectedValueOnce(new Error("connection reset after write"))
      .mockResolvedValueOnce(storedRecord)

    await expect(ensureAccountSharingKey(userOneMaster)).rejects.toThrow()
    const recovered = await ensureAccountSharingKey(userOneMaster)

    expect(recovered.sharingPublicKey).toBe("stored-public")
    expect(mocks.createAccountSharingKey).toHaveBeenCalledTimes(1)
    expect(mocks.openSharingPrivateKey).toHaveBeenCalledTimes(1)
    expect(mocks.openSharingPrivateKey).toHaveBeenCalledWith(
      {
        sharingPublicKey: "stored-public",
        wrappedSharingPrivateKey: "stored-wrapped-private",
        version: 1,
      },
      accountKey
    )
  })

  it("rejects a sharing record bound to a different authenticated user", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ...storedRecord,
      user_id: "user-two",
    })

    await expect(ensureAccountSharingKey(userOneMaster)).rejects.toThrow(
      "Could not initialize the secure vault"
    )

    expect(mocks.createAccountSharingKey).not.toHaveBeenCalled()
    expect(mocks.openSharingPrivateKey).not.toHaveBeenCalled()
  })

  it("binds a null-record PUT to the expected user so a cookie switch is rejected", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(emptyRecord)
      .mockRejectedValueOnce(new Error("conflict"))

    await expect(ensureAccountSharingKey(userOneMaster)).rejects.toThrow(
      "Could not initialize the secure vault"
    )

    expect(mocks.apiFetch).toHaveBeenNthCalledWith(2, "/account/sharing-key", {
      method: "PUT",
      body: JSON.stringify({
        expected_user_id: "user-one",
        sharing_public_key: "new-public",
        wrapped_sharing_private_key: "new-wrapped-private",
        sharing_key_version: 1,
      }),
    })
    expect(mocks.openSharingPrivateKey).not.toHaveBeenCalled()
  })

  it("isolates overlapping old-user completion from a new user's in-flight cache", async () => {
    let resolveOld!: (value: typeof storedRecord) => void
    let resolveNew!: (value: typeof storedRecord) => void
    const oldResponse = new Promise<typeof storedRecord>((resolve) => {
      resolveOld = resolve
    })
    const newResponse = new Promise<typeof storedRecord>((resolve) => {
      resolveNew = resolve
    })
    mocks.apiFetch
      .mockReturnValueOnce(oldResponse)
      .mockReturnValueOnce(newResponse)

    const oldCompletion = ensureAccountSharingKey(userOneMaster).catch(
      (error: unknown) => error
    )
    await vi.waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    })
    signIn("user-two")
    const newCompletion = ensureAccountSharingKey(userTwoMaster)

    resolveNew({
      ...storedRecord,
      user_id: "user-two",
      sharing_public_key: "user-two-public",
      wrapped_sharing_private_key: "user-two-wrapped-private",
    })
    const newMaterial = await newCompletion
    resolveOld(storedRecord)

    await expect(oldCompletion).resolves.toMatchObject({
      name: "AccountSharingKeyError",
    })
    await expect(ensureAccountSharingKey(userTwoMaster)).resolves.toBe(
      newMaterial
    )
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
  })

  it("replaces transport details with a retryable generic error", async () => {
    mocks.apiFetch.mockRejectedValueOnce(
      new Error("connection reset at internal-host.example")
    )

    const failure = await ensureAccountSharingKey(userOneMaster).catch(
      (error: unknown) => error
    )

    expect(failure).toMatchObject({
      name: "AccountSharingKeyError",
      message: "Could not initialize the secure vault",
    })
    expect(String(failure)).not.toContain("internal-host.example")
  })

  it("rejects an incomplete server record without generating a replacement", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      user_id: "user-one",
      sharing_public_key: "public-only",
      wrapped_sharing_private_key: null,
      sharing_key_version: 1,
    })

    await expect(ensureAccountSharingKey(userOneMaster)).rejects.toThrow()

    expect(mocks.createAccountSharingKey).not.toHaveBeenCalled()
    expect(mocks.openSharingPrivateKey).not.toHaveBeenCalled()
  })
})
