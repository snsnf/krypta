"use client"

import {
  deriveAuthVerifier,
  deriveUnlockKey,
  deriveVaultSalt,
  unwrapAccountKey,
} from "@krypta/crypto"
import { apiFetch } from "./api"
import {
  AccountSharingKeyError,
  ensureAccountSharingKey,
} from "./account-sharing-key"
import {
  getPendingAccountKey,
  promotePendingAccountKey,
  setPendingAccountKey,
  useAuthStore,
  type UserBoundAccountKey,
} from "./auth-store"
import { loadPersistedAccountKey, persistAccountKey } from "./device-key"
import { ensureSodiumReady } from "./sodium-ready"

interface CurrentSession {
  user_id: string
  email: string
  instance_admin: boolean
  totp_enabled: boolean
  second_factor_verified: boolean
  wrapped_account_key: string
}

interface PasswordProof {
  user_id: string
  wrapped_account_key: string
}

type DashboardVaultOutcome = "ready" | "unlock" | "retry" | "stale"

function vaultError(): AccountSharingKeyError {
  return new AccountSharingKeyError()
}

function assertCurrentUser(expectedUserId: string): void {
  if (useAuthStore.getState().userId !== expectedUserId) throw vaultError()
}

/**
 * Argon2id over the password with the email-derived salt.
 *
 * The salt is no longer served by the API, so the email is required rather
 * than optional: without it there is nothing to derive against.
 */
export async function deriveVaultUnlockKey(
  email: string,
  password: string
): Promise<string> {
  await ensureSodiumReady()
  return deriveUnlockKey(password, deriveVaultSalt(email))
}

/**
 * Proves the password for the signed-in account and returns a single-use
 * receipt for an operation a session alone must not be able to perform:
 * enrolling a second factor, minting a vault recovery code, deleting an
 * account.
 *
 * Only a verifier derived from the password is sent, never the password.
 */
export async function requestReauthenticationReceipt(
  email: string,
  password: string
): Promise<string> {
  const unlockKey = await deriveVaultUnlockKey(email, password)
  const { reauthentication_receipt } = await apiFetch<{
    reauthentication_receipt: string
  }>("/auth/reauthenticate", {
    method: "POST",
    body: JSON.stringify({ verifier: deriveAuthVerifier(unlockKey) }),
  })
  return reauthentication_receipt
}

/**
 * The tail shared by every vault bootstrap once an unwrapped account key is
 * available: assert the current user is still the one being unlocked, stage
 * the key as pending, persist it under the device key, and open the account
 * sharing key. The key remains pending (not dashboard-ready) until the
 * account sharing material opens successfully.
 *
 * Callers differ only in how they arrive at `accountKey`. The password path
 * derives an unlock key with Argon2 and unwraps it; the passkey path already
 * has it unwrapped, because the PRF output opened the wrapper in the browser.
 */
async function finishVaultBootstrap(
  userId: string,
  accountKey: string
): Promise<void> {
  assertCurrentUser(userId)
  const material: UserBoundAccountKey = {
    expectedUserId: userId,
    accountKey,
  }
  if (!setPendingAccountKey(material)) throw vaultError()
  await persistAccountKey(userId, accountKey)
  assertCurrentUser(userId)
  await ensureAccountSharingKey(material)
  assertCurrentUser(userId)
  if (!promotePendingAccountKey(material)) throw vaultError()
}

/**
 * Bootstraps a vault from an unlock key that an authentication endpoint has
 * already accepted the verifier for.
 *
 * The unlock key opens nothing but the account key. Everything downstream
 * (form keys, the account sharing keypair) is wrapped under the *account* key,
 * so that is what is persisted and published.
 */
export async function bootstrapVaultWithUnlockKey(
  userId: string,
  email: string,
  unlockKey: string,
  wrappedAccountKey: string
): Promise<void> {
  useAuthStore.getState().setSession({ userId, email, wrappedAccountKey })
  await ensureSodiumReady()
  assertCurrentUser(userId)

  let accountKey: string
  try {
    accountKey = unwrapAccountKey(wrappedAccountKey, unlockKey)
  } catch {
    // A verifier the server accepted paired with a wrapper that will not open
    // is a local failure only. Reporting it to the API would tell the server
    // whether a wrapper opens, which is exactly what it must not learn.
    throw vaultError()
  }

  await finishVaultBootstrap(userId, accountKey)
}

/**
 * Opens the vault when the account key has already been unwrapped, which is
 * the passkey case: the PRF output opened the wrapper in `loginWithPasskey`,
 * so there is no password, no email-derived salt and no Argon2 step here.
 *
 * `wrappedAccountKey` in session state is deliberately left untouched: it
 * names the account key as sealed under the *password*-derived unlock key
 * (see its own doc comment in `auth-store.ts`), and the passkey path never
 * sees that wrapper. `setSession` keeps whichever value, if any, is already
 * there for this user.
 */
export async function bootstrapVaultWithAccountKey(
  userId: string,
  accountKey: string
): Promise<void> {
  useAuthStore.getState().setSession({ userId })
  await ensureSodiumReady()
  await finishVaultBootstrap(userId, accountKey)
}

/**
 * Proves the password against the currently authenticated account before any
 * persistence, publication, or sharing-key request occurs.
 *
 * The derivation now has to run *before* the proof rather than after it: the
 * server authenticates a verifier, and the verifier is a hash of the unlock
 * key. That key stays local either way, and nothing is written or published
 * until the server has accepted it.
 */
export async function unlockVaultWithPassword(password: string): Promise<void> {
  const state = useAuthStore.getState()
  const expectedUserId = state.userId
  const email = state.email
  if (expectedUserId === null || email === null) throw vaultError()

  const unlockKey = await deriveVaultUnlockKey(email, password)
  assertCurrentUser(expectedUserId)

  const proof = await apiFetch<PasswordProof>("/auth/reauthenticate", {
    method: "POST",
    body: JSON.stringify({ verifier: deriveAuthVerifier(unlockKey) }),
  })
  if (
    proof.user_id !== expectedUserId ||
    useAuthStore.getState().userId !== expectedUserId
  ) {
    throw vaultError()
  }

  await bootstrapVaultWithUnlockKey(
    expectedUserId,
    email,
    unlockKey,
    proof.wrapped_account_key
  )
}

let restoreInFlight: Promise<DashboardVaultOutcome> | null = null

/**
 * Restores a device-wrapped key without exposing it to dashboard state early.
 *
 * Concurrent callers share one restore. Without this they raced: React invokes
 * the calling effect twice in development, both restores ran, and the loser's
 * `promotePendingAccountKey` found the pending material already claimed by the
 * winner. It then reported "retry", which sent an otherwise-healthy session to
 * /unlock, remounting the page and starting the whole cycle again.
 */
export function restoreVaultForDashboard(): Promise<DashboardVaultOutcome> {
  restoreInFlight ??= runRestoreForDashboard().finally(() => {
    restoreInFlight = null
  })
  return restoreInFlight
}

async function runRestoreForDashboard(): Promise<DashboardVaultOutcome> {
  const me = await apiFetch<CurrentSession>("/auth/me")
  useAuthStore.getState().setSession({
    userId: me.user_id,
    email: me.email,
    wrappedAccountKey: me.wrapped_account_key,
    instanceAdmin: me.instance_admin,
    totpEnabled: me.totp_enabled,
    totpVerified: me.second_factor_verified,
  })

  // The persisted value is already the account key, so there is no wrapper to
  // open here: the device key alone restores the vault.
  const restored = await loadPersistedAccountKey(me.user_id)
  if (useAuthStore.getState().userId !== me.user_id) return "stale"
  if (restored === null) return "unlock"

  const material: UserBoundAccountKey = {
    expectedUserId: me.user_id,
    accountKey: restored,
  }
  if (!setPendingAccountKey(material)) return "stale"
  try {
    await ensureAccountSharingKey(material)
    if (useAuthStore.getState().userId !== me.user_id) return "stale"
    if (!promotePendingAccountKey(material)) {
      return useAuthStore.getState().userId === me.user_id ? "retry" : "stale"
    }
    return "ready"
  } catch {
    return useAuthStore.getState().userId === me.user_id ? "retry" : "stale"
  }
}

/** Retries sharing bootstrap with the in-memory pending key, without a password. */
export async function retryPendingVault(expectedUserId: string): Promise<void> {
  assertCurrentUser(expectedUserId)
  const material = getPendingAccountKey(expectedUserId)
  if (material === null) throw vaultError()

  await ensureAccountSharingKey(material)
  assertCurrentUser(expectedUserId)
  if (!promotePendingAccountKey(material)) throw vaultError()
}
