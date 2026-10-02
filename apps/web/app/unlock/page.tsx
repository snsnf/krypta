"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  RotateClockwiseIcon,
  SquareUnlock01Icon,
} from "@hugeicons/core-free-icons"
import { apiFetch, ApiClientError } from "@/lib/api"
import { AccountSharingKeyError } from "@/lib/account-sharing-key"
import { safeAuthReturn } from "@/lib/auth-return"
import { getPendingAccountKey, useAuthStore } from "@/lib/auth-store"
import { retryPendingVault, unlockVaultWithPassword } from "@/lib/vault-access"
import { Button } from "@/components/ui/button"
import { CredentialInput } from "@/components/credential-input"
import { useAppT } from "@/lib/app-i18n"
import { AuthShell } from "@/components/auth-shell"

function UnlockPageContent() {
  const router = useRouter()
  const t = useAppT()
  const searchParams = useSearchParams()
  const [authReturn] = useState(() => safeAuthReturn(searchParams.get("next")))
  const [vaultRetryRequested] = useState(
    () => searchParams.get("vault") === "retry"
  )
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [vaultRetry, setVaultRetry] = useState(false)
  const setSession = useAuthStore((s) => s.setSession)
  const sessionUserId = useRef<string | null>(null)
  // Submitting before /auth/me lands used to fail, because the address it
  // supplies is what the unlock-key salt derives from. Keeping the promise lets
  // handleSubmit wait for it instead, so a fast submit unlocks rather than
  // erroring.
  const sessionLoad = useRef<Promise<void> | null>(null)

  useEffect(() => {
    sessionLoad.current = apiFetch<{
      user_id: string
      email: string
      instance_admin: boolean
      totp_enabled: boolean
      second_factor_verified: boolean
    }>("/auth/me")
      .then((me) => {
        sessionUserId.current = me.user_id
        setSession({
          userId: me.user_id,
          email: me.email,
          instanceAdmin: me.instance_admin,
          totpEnabled: me.totp_enabled,
          totpVerified: me.second_factor_verified,
        })
        if (vaultRetryRequested) {
          // The retry screen shows the vault message itself when no error is
          // set, so none is stored here (and the effect needs no translator).
          setVaultRetry(getPendingAccountKey(me.user_id) !== null)
        }
      })
      .catch(() => {
        router.replace(
          authReturn === "/invitations/accept"
            ? "/login?next=%2Finvitations%2Faccept"
            : "/login"
        )
      })
  }, [authReturn, router, setSession, vaultRetryRequested])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await sessionLoad.current
      const { userId } = useAuthStore.getState()
      // Reaching here without a session means /auth/me failed rather than that
      // the password is wrong, so do not blame the password.
      if (!userId) {
        setError(t("auth.unlock.sessionLoadFailed"))
        return
      }
      await unlockVaultWithPassword(password)
      router.replace(authReturn)
    } catch (err) {
      if (err instanceof AccountSharingKeyError) {
        setVaultRetry(
          sessionUserId.current !== null &&
            getPendingAccountKey(sessionUserId.current) !== null
        )
        setError(t("common.vaultInitFailed"))
      } else if (err instanceof ApiClientError) {
        setError(
          err.code === "unauthorized"
            ? t("auth.unlock.incorrectPassword")
            : err.code === "rate_limited"
              ? t("common.tooManyWait")
              : t("auth.unlock.unlockFailed")
        )
      } else {
        setError(t("auth.unlock.unlockFailed"))
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleVaultRetry(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      if (sessionUserId.current === null) throw new AccountSharingKeyError()
      await retryPendingVault(sessionUserId.current)
      setVaultRetry(false)
      router.replace(authReturn)
    } catch {
      setError(t("common.vaultInitFailed"))
    } finally {
      setLoading(false)
    }
  }

  if (vaultRetry) {
    return (
      <AuthShell>
        <form onSubmit={handleVaultRetry} className="flex flex-col gap-4">
          <div className="mb-2">
            <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
              {t("auth.login.finishUnlocking")}
            </h1>
            <p
              className="mt-1.5 text-sm text-muted-foreground"
              aria-live="polite"
            >
              {error ?? t("common.vaultInitFailed")}
            </p>
          </div>
          <Button type="submit" disabled={loading}>
            {!loading && (
              <HugeiconsIcon
                icon={RotateClockwiseIcon}
                size={16}
                data-icon="inline-start"
              />
            )}
            {loading ? t("common.tryingAgain") : t("common.tryAgain")}
          </Button>
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="mb-2">
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            {t("auth.unlock.title")}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("auth.unlock.body")}
          </p>
        </div>
        <CredentialInput
          type="password"
          required
          placeholder={t("common.password")}
          aria-label={t("common.password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p
          className={`text-sm text-destructive transition-opacity duration-150 ease-out ${
            error ? "opacity-100" : "h-0 opacity-0"
          }`}
          aria-live="polite"
        >
          {error}
        </p>
        <Button
          type="submit"
          disabled={loading}
          className="transition-transform duration-150 ease-out active:scale-[0.97]"
        >
          {!loading && (
            <HugeiconsIcon
              icon={SquareUnlock01Icon}
              size={16}
              data-icon="inline-start"
            />
          )}
          {loading ? t("auth.unlock.submitting") : t("auth.unlock.submit")}
        </Button>
      </form>
    </AuthShell>
  )
}

function UnlockFallback() {
  const t = useAppT()
  return (
    <AuthShell>
      <p role="status" className="text-sm text-muted-foreground">
        {t("auth.unlock.loading")}
      </p>
    </AuthShell>
  )
}

export default function UnlockPage() {
  return (
    <Suspense fallback={<UnlockFallback />}>
      <UnlockPageContent />
    </Suspense>
  )
}
