"use client"

import { useCallback, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { apiFetch } from "../lib/api"
import { ensureAccountSharingKey } from "../lib/account-sharing-key"
import { useAuthStore } from "../lib/auth-store"
import type { SafeAuthReturn } from "../lib/auth-return"

/**
 * Sends someone who already has a session away from /login and /signup.
 *
 * The mirror of `useEnsureUnlocked`. With an in-memory account key, sharing-key
 * bootstrap must also finish before navigation. Without one, only the session is
 * checked here: restoring the account key remains /dashboard's responsibility.
 *
 * Uses `router.replace` rather than a location assignment so an in-memory account
 * key survives, which avoids a pointless /unlock detour, and so Back does not
 * land on the form they were just redirected off.
 */
export function useRedirectIfAuthenticated(
  destination: SafeAuthReturn = "/dashboard"
): () => void {
  const router = useRouter()
  const userId = useAuthStore((s) => s.userId)
  const accountKey = useAuthStore((s) => s.accountKey)
  const interactiveAuthStarted = useRef(false)

  const beginInteractiveAuth = useCallback(() => {
    interactiveAuthStarted.current = true
  }, [])

  useEffect(() => {
    if (interactiveAuthStarted.current) return

    // Already unlocked in this tab: finish any pending sharing-key bootstrap
    // before allowing encrypted dashboard routes to render.
    if (userId !== null && accountKey !== null) {
      let cancelled = false
      ensureAccountSharingKey({ expectedUserId: userId, accountKey })
        .then(() => {
          if (!cancelled && !interactiveAuthStarted.current) {
            router.replace(destination)
          }
        })
        .catch(() => {
          // The auth form retains the valid session/account key and owns retry.
        })
      return () => {
        cancelled = true
      }
    }

    let cancelled = false
    apiFetch("/auth/me")
      .then(() => {
        if (!cancelled && !interactiveAuthStarted.current) {
          router.replace(destination)
        }
      })
      .catch(() => {
        // No usable session, so the form is the right thing to show.
      })

    return () => {
      cancelled = true
    }
  }, [destination, accountKey, router, userId])

  return beginInteractiveAuth
}
