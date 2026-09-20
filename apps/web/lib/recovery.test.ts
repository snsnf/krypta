import { beforeEach, describe, expect, it, vi } from "vitest"

const apiFetch = vi.fn()
vi.mock("@/lib/api", () => ({ apiFetch }))
// The password proof now goes through `vault-access`, which imports the API
// client by its relative path. Both specifiers resolve to the same mock, so
// every request this module causes is still captured and inspected below.
vi.mock("./api", () => ({ apiFetch }))

const { completeRecovery, regenerateRecoveryCode, verifyRecovery } =
  await import("./recovery")

describe("verifyRecovery", () => {
  beforeEach(() => apiFetch.mockReset())

  it("unwraps the account key with the typed recovery code", async () => {
    const {
      deriveRecoveryUnlockKey,
      generateAccountKey,
      generateRecoveryCode,
      wrapAccountKey,
    } = await import("@krypta/crypto")

    const accountKey = generateAccountKey()
    const recoveryCode = generateRecoveryCode()
    const unlockKey = await deriveRecoveryUnlockKey(recoveryCode, "a@b.com")
    apiFetch.mockResolvedValue({
      wrapped_account_key: wrapAccountKey(accountKey, unlockKey),
    })

    const result = await verifyRecovery({
      pendingToken: "t",
      email: "a@b.com",
      emailCode: "123456",
      recoveryCode: recoveryCode.toLowerCase().replace(/-/g, " "),
    })

    expect(result.accountKey).toBe(accountKey)
  })

  it("never sends the recovery code itself", async () => {
    const {
      generateAccountKey,
      generateRecoveryCode,
      deriveRecoveryUnlockKey,
      wrapAccountKey,
    } = await import("@krypta/crypto")
    const recoveryCode = generateRecoveryCode()
    const unlockKey = await deriveRecoveryUnlockKey(recoveryCode, "a@b.com")
    apiFetch.mockResolvedValue({
      wrapped_account_key: wrapAccountKey(generateAccountKey(), unlockKey),
    })

    await verifyRecovery({
      pendingToken: "t",
      email: "a@b.com",
      emailCode: "123456",
      recoveryCode,
    })

    const sent = apiFetch.mock.calls[0][1].body as string
    expect(sent).not.toContain(recoveryCode)
    expect(sent).not.toContain(recoveryCode.replace(/-/g, ""))
  })

  it("surfaces a wrong recovery code as a local failure", async () => {
    const {
      generateAccountKey,
      generateRecoveryCode,
      deriveRecoveryUnlockKey,
      wrapAccountKey,
    } = await import("@krypta/crypto")
    const unlockKey = await deriveRecoveryUnlockKey(
      generateRecoveryCode(),
      "a@b.com"
    )
    apiFetch.mockResolvedValue({
      wrapped_account_key: wrapAccountKey(generateAccountKey(), unlockKey),
    })

    await expect(
      verifyRecovery({
        pendingToken: "t",
        email: "a@b.com",
        emailCode: "123456",
        recoveryCode: generateRecoveryCode(),
      })
    ).rejects.toThrow()
  })
})

describe("completeRecovery", () => {
  beforeEach(() => apiFetch.mockReset())

  it("re-wraps the same account key under the new password and a fresh code", async () => {
    const {
      generateAccountKey,
      unwrapAccountKey,
      deriveUnlockKey,
      deriveVaultSalt,
    } = await import("@krypta/crypto")
    apiFetch.mockResolvedValue({ ok: true })
    const accountKey = generateAccountKey()

    const { recoveryCode } = await completeRecovery({
      email: "a@b.com",
      accountKey,
      newPassword: "a-new-password",
    })

    const body = JSON.parse(apiFetch.mock.calls[0][1].body as string)
    const newUnlockKey = await deriveUnlockKey(
      "a-new-password",
      deriveVaultSalt("a@b.com")
    )
    expect(
      unwrapAccountKey(body.wrapped_account_key_password, newUnlockKey)
    ).toBe(accountKey)
    expect(recoveryCode).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/
    )
  })

  it("never sends the new password or the new recovery code", async () => {
    const { generateAccountKey } = await import("@krypta/crypto")
    apiFetch.mockResolvedValue({ ok: true })
    const accountKey = generateAccountKey()
    const newPassword = "a-new-password"

    const { recoveryCode } = await completeRecovery({
      email: "a@b.com",
      accountKey,
      newPassword,
    })

    const sent = apiFetch.mock.calls[0][1].body as string
    expect(sent).not.toContain(newPassword)
    expect(sent).not.toContain(recoveryCode)
    expect(sent).not.toContain(recoveryCode.replace(/-/g, ""))
  })
})

describe("regenerateRecoveryCode", () => {
  beforeEach(() => apiFetch.mockReset())

  it("never sends the password or the new recovery code", async () => {
    const { generateAccountKey } = await import("@krypta/crypto")
    const password = "the-current-password"
    apiFetch
      .mockResolvedValueOnce({ reauthentication_receipt: "receipt" })
      .mockResolvedValueOnce({ ok: true })

    const { recoveryCode } = await regenerateRecoveryCode({
      email: "a@b.com",
      password,
      accountKey: generateAccountKey(),
    })

    // Both requests, not just the second: the reauthenticate call is the one
    // that handles the password, and it must send only a derived verifier.
    const sent = apiFetch.mock.calls
      .map((call) => call[1].body as string)
      .join("")
    expect(sent).not.toContain(password)
    expect(sent).not.toContain(recoveryCode)
    expect(sent).not.toContain(recoveryCode.replace(/-/g, ""))
  })
})
