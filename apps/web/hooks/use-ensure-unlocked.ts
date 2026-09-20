"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuthStore } from "../lib/auth-store"
import { restoreVaultForDashboard } from "../lib/vault-access"

/**
 * Ensures the current page has an unlocked account key before rendering data that needs it.
 * On a fresh page load (accountKey is null, e.g. after a refresh or browser restart) this
 * tries a silent restore via the persisted device key and initializes account sharing
 * material before exposing the account key to encrypted pages. It only falls back to the
 * password-entry screen if restore/bootstrap fails. An invalid/expired session always
 * wins over any persisted key and sends the user to /login, never /unlock.
 */
export function useEnsureUnlocked(): void {
  const router = useRouter()
  const accountKey = useAuthStore((s) => s.accountKey)

  useEffect(() => {
    if (accountKey !== null) return

    let cancelled = false
    void (async () => {
      try {
        const outcome = await restoreVaultForDashboard()
        if (cancelled || outcome === "ready" || outcome === "stale") return
        router.replace(outcome === "retry" ? "/unlock?vault=retry" : "/unlock")
      } catch {
        if (!cancelled) router.replace("/login")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [accountKey, router])
}
