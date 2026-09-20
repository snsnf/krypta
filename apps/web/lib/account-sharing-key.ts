"use client"

import {
  createAccountSharingKey,
  openSharingPrivateKey,
  type AccountSharingKeyRecord,
} from "@krypta/crypto"
import { apiFetch } from "./api"
import {
  installAuthClearHandler,
  useAuthStore,
  type UserBoundAccountKey,
} from "./auth-store"
import { ensureSodiumReady } from "./sodium-ready"

export interface AccountSharingMaterial {
  sharingPublicKey: string
  wrappedSharingPrivateKey: string
  sharingPrivateKey: string
  version: 1
}

export class AccountSharingKeyError extends Error {
  constructor() {
    super("Could not initialize the secure vault")
    this.name = "AccountSharingKeyError"
  }
}

interface SharingKeyResponse {
  user_id: string
  sharing_public_key: string | null
  wrapped_sharing_private_key: string | null
  sharing_key_version: number | null
}

interface SharingKeyCacheEntry {
  expectedUserId: string
  token: symbol
  promise: Promise<AccountSharingMaterial>
}

let sharingKeyCache: SharingKeyCacheEntry | null = null

function clearAccountSharingKeyCache(): void {
  sharingKeyCache = null
}

installAuthClearHandler(clearAccountSharingKeyCache)

function vaultInitializationError(): AccountSharingKeyError {
  return new AccountSharingKeyError()
}

function assertCurrentUser(userId: string): void {
  if (useAuthStore.getState().userId !== userId) {
    throw vaultInitializationError()
  }
}

function recordFromResponse(
  response: SharingKeyResponse
): AccountSharingKeyRecord | null {
  const isEmpty =
    response.sharing_public_key === null &&
    response.wrapped_sharing_private_key === null &&
    response.sharing_key_version === null

  if (isEmpty) return null

  if (
    typeof response.sharing_public_key !== "string" ||
    typeof response.wrapped_sharing_private_key !== "string" ||
    response.sharing_key_version !== 1
  ) {
    throw vaultInitializationError()
  }

  return {
    sharingPublicKey: response.sharing_public_key,
    wrappedSharingPrivateKey: response.wrapped_sharing_private_key,
    version: 1,
  }
}

async function initializeAccountSharingKey(
  material: UserBoundAccountKey
): Promise<AccountSharingMaterial> {
  const { expectedUserId, accountKey } = material
  assertCurrentUser(expectedUserId)
  await ensureSodiumReady()
  assertCurrentUser(expectedUserId)

  const response = await apiFetch<SharingKeyResponse>("/account/sharing-key")
  assertCurrentUser(expectedUserId)
  if (response.user_id !== expectedUserId) throw vaultInitializationError()

  let record = recordFromResponse(response)
  if (record === null) {
    assertCurrentUser(expectedUserId)
    record = createAccountSharingKey(accountKey)
    assertCurrentUser(expectedUserId)
    await apiFetch<Record<string, never>>("/account/sharing-key", {
      method: "PUT",
      body: JSON.stringify({
        expected_user_id: expectedUserId,
        sharing_public_key: record.sharingPublicKey,
        wrapped_sharing_private_key: record.wrappedSharingPrivateKey,
        sharing_key_version: record.version,
      }),
    })
    assertCurrentUser(expectedUserId)
  }

  assertCurrentUser(expectedUserId)
  const opened = {
    ...record,
    sharingPrivateKey: openSharingPrivateKey(record, accountKey),
  }
  assertCurrentUser(expectedUserId)
  return opened
}

export function ensureAccountSharingKey(
  material: UserBoundAccountKey
): Promise<AccountSharingMaterial> {
  const { expectedUserId } = material
  if (useAuthStore.getState().userId !== expectedUserId) {
    return Promise.reject(vaultInitializationError())
  }

  if (sharingKeyCache?.expectedUserId === expectedUserId) {
    return sharingKeyCache.promise
  }

  const token = Symbol("account-sharing-key-bootstrap")
  const promise = initializeAccountSharingKey(material).catch(
    (error: unknown) => {
      if (sharingKeyCache?.token === token) clearAccountSharingKeyCache()
      throw error instanceof AccountSharingKeyError
        ? error
        : vaultInitializationError()
    }
  )
  sharingKeyCache = { expectedUserId, token, promise }
  return promise
}
