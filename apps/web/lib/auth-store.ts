import { create } from "zustand"

type AuthClearHandler = () => void

export interface UserBoundAccountKey {
  expectedUserId: string
  accountKey: string
}

let authClearHandler: AuthClearHandler | null = null
let pendingAccountKey: UserBoundAccountKey | null = null

/**
 * Installs the single synchronous cleanup hook owned by ephemeral crypto
 * material. Replacing it clears the old module instance first, which avoids
 * retaining private material or stale handlers across Fast Refresh updates.
 */
export function installAuthClearHandler(handler: AuthClearHandler): void {
  authClearHandler?.()
  authClearHandler = handler
}

function clearEphemeralAuthMaterial(): void {
  pendingAccountKey = null
  authClearHandler?.()
}

export function setPendingAccountKey(material: UserBoundAccountKey): boolean {
  if (useAuthStore.getState().userId !== material.expectedUserId) return false
  pendingAccountKey = { ...material }
  useAuthStore.setState({ accountKey: null })
  return true
}

export function getPendingAccountKey(
  expectedUserId: string
): UserBoundAccountKey | null {
  return pendingAccountKey?.expectedUserId === expectedUserId
    ? { ...pendingAccountKey }
    : null
}

export function promotePendingAccountKey(material: UserBoundAccountKey): boolean {
  if (useAuthStore.getState().userId !== material.expectedUserId) return false
  if (
    pendingAccountKey?.expectedUserId !== material.expectedUserId ||
    pendingAccountKey.accountKey !== material.accountKey
  ) {
    return false
  }
  pendingAccountKey = null
  useAuthStore.setState({ accountKey: material.accountKey })
  return true
}

interface AuthState {
  userId: string | null
  email: string | null
  accountKey: string | null
  /**
   * The account key still sealed under the password-derived unlock key, as the
   * API returned it. Kept because it is the value a second unlock method has to
   * be enrolled against; it is ciphertext, not key material.
   */
  wrappedAccountKey: string | null
  instanceAdmin: boolean | null
  totpEnabled: boolean | null
  totpVerified: boolean | null
  setSession: (session: {
    userId: string
    email?: string
    wrappedAccountKey?: string
    instanceAdmin?: boolean
    totpEnabled?: boolean
    totpVerified?: boolean
  }) => void
  setAdminMetadata: (metadata: {
    userId: string
    instanceAdmin: boolean
    totpEnabled: boolean
    totpVerified: boolean
  }) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  userId: null,
  email: null,
  accountKey: null,
  wrappedAccountKey: null,
  instanceAdmin: null,
  totpEnabled: null,
  totpVerified: null,
  setSession: (session) =>
    set((state) => {
      const userChanged = state.userId !== session.userId
      if (userChanged) clearEphemeralAuthMaterial()
      return {
        userId: session.userId,
        email: session.email ?? null,
        accountKey: userChanged ? null : state.accountKey,
        wrappedAccountKey:
          session.wrappedAccountKey ??
          (userChanged ? null : state.wrappedAccountKey),
        instanceAdmin:
          session.instanceAdmin ?? (userChanged ? null : state.instanceAdmin),
        totpEnabled:
          session.totpEnabled ?? (userChanged ? null : state.totpEnabled),
        totpVerified:
          session.totpVerified ?? (userChanged ? null : state.totpVerified),
      }
    }),
  setAdminMetadata: (metadata) =>
    set((state) =>
      state.userId === metadata.userId
        ? {
            instanceAdmin: metadata.instanceAdmin,
            totpEnabled: metadata.totpEnabled,
            totpVerified: metadata.totpVerified,
          }
        : state
    ),
  clear: () => {
    clearEphemeralAuthMaterial()
    set({
      userId: null,
      email: null,
      accountKey: null,
      wrappedAccountKey: null,
      instanceAdmin: null,
      totpEnabled: null,
      totpVerified: null,
    })
  },
}))

/**
 * A settings mutation changes account enrollment but never proves the current
 * session's second factor. Keep navigation metadata conservative until login.
 */
export function syncCurrentSessionTotpMetadata(totpEnabled: boolean): void {
  const state = useAuthStore.getState()
  if (state.userId === null) return
  state.setAdminMetadata({
    userId: state.userId,
    instanceAdmin: state.instanceAdmin === true,
    totpEnabled,
    totpVerified: false,
  })
}
