import {
  deriveAuthVerifier,
  deriveRecoveryUnlockKey,
  deriveRecoveryVerifier,
  deriveUnlockKey,
  deriveVaultSalt,
  generateRecoveryCode,
  unwrapAccountKey,
  wrapAccountKey,
} from "@krypta/crypto"
import { apiFetch } from "@/lib/api"
import { requestReauthenticationReceipt } from "./vault-access"
import { ensureSodiumReady } from "./sodium-ready"

/**
 * Vault recovery, orchestrated here rather than in the page component so it
 * stays testable: `vitest` in this repo has no DOM, so a page component's
 * behavior is unreachable by unit tests.
 *
 * The typed recovery code never leaves this module. Only a one-way verifier
 * derived from it is ever sent, and the account key is unwrapped locally.
 */

export async function startRecovery(
  email: string,
  language: string = "en"
): Promise<{ pendingToken: string }> {
  const { pending_token } = await apiFetch<{ pending_token: string }>(
    "/auth/recover/start",
    {
      method: "POST",
      body: JSON.stringify({ email, language }),
    }
  )
  return { pendingToken: pending_token }
}

interface VerifyRecoveryInput {
  pendingToken: string
  email: string
  emailCode: string
  recoveryCode: string
  totpCode?: string
}

export async function verifyRecovery({
  pendingToken,
  email,
  emailCode,
  recoveryCode,
  totpCode,
}: VerifyRecoveryInput): Promise<{ accountKey: string }> {
  await ensureSodiumReady()
  const unlockKey = await deriveRecoveryUnlockKey(recoveryCode, email)

  const { wrapped_account_key } = await apiFetch<{
    wrapped_account_key: string
  }>("/auth/recover/verify", {
    method: "POST",
    body: JSON.stringify({
      pending_token: pendingToken,
      email_code: emailCode,
      recovery_verifier: deriveRecoveryVerifier(unlockKey),
      ...(totpCode ? { totp_code: totpCode } : {}),
    }),
  })

  // A correct verifier paired with a wrapper that will not open is a purely
  // local failure. It must not be reported to the API: that would tell the
  // server exactly the thing it must never learn.
  return { accountKey: unwrapAccountKey(wrapped_account_key, unlockKey) }
}

interface CompleteRecoveryInput {
  email: string
  accountKey: string
  newPassword: string
}

export async function completeRecovery({
  email,
  accountKey,
  newPassword,
}: CompleteRecoveryInput): Promise<{ recoveryCode: string }> {
  await ensureSodiumReady()
  const vaultSalt = deriveVaultSalt(email)
  const newUnlockKey = await deriveUnlockKey(newPassword, vaultSalt)
  const newRecoveryCode = generateRecoveryCode()
  const newRecoveryUnlockKey = await deriveRecoveryUnlockKey(
    newRecoveryCode,
    email
  )

  await apiFetch<{ ok: boolean }>("/auth/recover/complete", {
    method: "POST",
    body: JSON.stringify({
      new_password_verifier: deriveAuthVerifier(newUnlockKey),
      wrapped_account_key_password: wrapAccountKey(accountKey, newUnlockKey),
      new_recovery_verifier: deriveRecoveryVerifier(newRecoveryUnlockKey),
      wrapped_account_key_recovery: wrapAccountKey(
        accountKey,
        newRecoveryUnlockKey
      ),
    }),
  })

  return { recoveryCode: newRecoveryCode }
}

interface RegenerateRecoveryCodeInput {
  email: string
  password: string
  accountKey: string
}

/**
 * Mints a replacement recovery code for a signed-in user who still has their
 * password but has lost the code shown once at signup.
 *
 * The password never leaves this module: it is only used locally to derive
 * the same verifier `/auth/reauthenticate` already accepts elsewhere, proving
 * the request is not just a stolen session. The account key passed in is the
 * one already held in memory: it is re-wrapped under a freshly generated
 * code's unlock key, never regenerated, so every existing form stays
 * decryptable.
 */
export async function regenerateRecoveryCode({
  email,
  password,
  accountKey,
}: RegenerateRecoveryCodeInput): Promise<{ recoveryCode: string }> {
  await ensureSodiumReady()

  const reauthentication_receipt = await requestReauthenticationReceipt(
    email,
    password
  )

  const recoveryCode = generateRecoveryCode()
  const recoveryUnlockKey = await deriveRecoveryUnlockKey(recoveryCode, email)

  await apiFetch<{ ok: boolean }>("/account/recovery-code", {
    method: "POST",
    body: JSON.stringify({
      reauthentication_receipt,
      recovery_verifier: deriveRecoveryVerifier(recoveryUnlockKey),
      wrapped_account_key_recovery: wrapAccountKey(
        accountKey,
        recoveryUnlockKey
      ),
    }),
  })

  return { recoveryCode }
}
