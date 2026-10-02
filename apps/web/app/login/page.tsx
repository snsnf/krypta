"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FingerPrintIcon,
  Login03Icon,
  RotateClockwiseIcon,
  ShieldKeyIcon,
} from "@hugeicons/core-free-icons"
import { deriveAuthVerifier } from "@krypta/crypto"
import { apiFetch, ApiClientError } from "@/lib/api"
import { safeAuthReturn } from "@/lib/auth-return"
import { AccountSharingKeyError } from "@/lib/account-sharing-key"
import { loginWithPasskey } from "@/lib/passkey"
import { ensureSodiumReady } from "@/lib/sodium-ready"
import {
  bootstrapVaultWithAccountKey,
  bootstrapVaultWithUnlockKey,
  deriveVaultUnlockKey,
  retryPendingVault,
} from "@/lib/vault-access"
import { Button } from "@/components/ui/button"
import { CredentialInput } from "@/components/credential-input"
import { useAppLanguage, useAppT } from "@/lib/app-i18n"
import { describeApiError } from "@/lib/api-error-text"
import { AuthShell } from "@/components/auth-shell"
import { useRedirectIfAuthenticated } from "@/hooks/use-redirect-if-authenticated"

function LoginPageContent() {
  const searchParams = useSearchParams()
  const [authReturn] = useState(() => safeAuthReturn(searchParams.get("next")))
  const beginInteractiveAuth = useRedirectIfAuthenticated(authReturn)
  const router = useRouter()
  const t = useAppT()
  const language = useAppLanguage()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [vaultRetry, setVaultRetry] = useState(false)
  // Set when the password step succeeds but a code is still required. The
  // unlock key derived from the password is held across the two steps: the
  // server only ever sees the verifier hashed from it, and the vault can only
  // be opened once the second factor clears.
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const vaultUserId = useRef<string | null>(null)
  const unlockKey = useRef<string | null>(null)
  // Checked in an effect, never during render: the server always renders
  // without this button, and reading window.PublicKeyCredential at render
  // time would make the client's first render disagree with it, failing
  // hydration.
  const [passkeySupported, setPasskeySupported] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) {
        setPasskeySupported(
          typeof window !== "undefined" && !!window.PublicKeyCredential
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handlePasskeyLogin() {
    beginInteractiveAuth()
    setError(null)
    setLoading(true)
    try {
      const { userId, accountKey } = await loginWithPasskey()
      vaultUserId.current = userId
      await bootstrapVaultWithAccountKey(userId, accountKey)
      router.replace(authReturn)
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        // The user dismissed the browser's picker. Not an error worth showing.
        return
      }
      handleLoginError(err)
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    beginInteractiveAuth()
    setError(null)
    setLoading(true)
    try {
      await ensureSodiumReady()
      unlockKey.current = await deriveVaultUnlockKey(email, password)
      const result = await apiFetch<{
        user_id?: string
        wrapped_account_key?: string
        totp_required?: boolean
        pending_token?: string
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email,
          verifier: deriveAuthVerifier(unlockKey.current),
        }),
      })

      if (result.totp_required && result.pending_token) {
        setPendingToken(result.pending_token)
        return
      }

      await completeLogin(result.user_id!, result.wrapped_account_key!)
    } catch (err) {
      handleLoginError(err)
    } finally {
      setLoading(false)
    }
  }

  async function completeLogin(userId: string, wrappedAccountKey: string) {
    if (unlockKey.current === null) throw new AccountSharingKeyError()
    vaultUserId.current = userId
    await bootstrapVaultWithUnlockKey(
      userId,
      email,
      unlockKey.current,
      wrappedAccountKey
    )
    router.replace(authReturn)
  }

  function handleLoginError(err: unknown): void {
    if (err instanceof AccountSharingKeyError) {
      setVaultRetry(true)
      setError(t("common.vaultInitFailed"))
      return
    }
    setError(
      err instanceof ApiClientError && err.code === "unauthorized"
        ? t("auth.login.invalidCredentials")
        : describeApiError(err, t, language)
    )
  }

  async function handleVaultRetry(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      beginInteractiveAuth()
      if (vaultUserId.current === null) throw new AccountSharingKeyError()
      await retryPendingVault(vaultUserId.current)
      setVaultRetry(false)
      router.replace(authReturn)
    } catch {
      setError(t("common.vaultInitFailed"))
    } finally {
      setLoading(false)
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      beginInteractiveAuth()
      await ensureSodiumReady()
      const { user_id, wrapped_account_key } = await apiFetch<{
        user_id: string
        wrapped_account_key: string
      }>("/auth/2fa/verify", {
        method: "POST",
        body: JSON.stringify({
          pending_token: pendingToken,
          code: code.trim(),
        }),
      })
      await completeLogin(user_id, wrapped_account_key)
    } catch (err) {
      if (err instanceof AccountSharingKeyError) {
        setVaultRetry(true)
        setError(t("common.vaultInitFailed"))
        return
      }
      // The handle is spent on any attempt, so a retry has to start from the
      // password again. Saying so beats leaving the user retyping codes.
      setPendingToken(null)
      setCode("")
      setError(
        err instanceof ApiClientError && err.code === "rate_limited"
          ? t("auth.login.tooManySignIn")
          : t("auth.login.codeRejected")
      )
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

  if (pendingToken !== null) {
    return (
      <AuthShell>
        <form onSubmit={handleCodeSubmit} className="flex flex-col gap-4">
          <div className="mb-2">
            <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
              {t("auth.login.twoFactorTitle")}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("auth.login.twoFactorBody")}
            </p>
          </div>
          <CredentialInput
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode="text"
            placeholder={t("auth.login.twoFactorPlaceholder")}
            aria-label={t("auth.login.twoFactorTitle")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <p
            className={`text-sm text-destructive transition-opacity duration-150 ease-out ${
              error ? "opacity-100" : "h-0 opacity-0"
            }`}
            aria-live="polite"
          >
            {error}
          </p>
          <Button type="submit" disabled={loading}>
            {!loading && (
              <HugeiconsIcon
                icon={ShieldKeyIcon}
                size={16}
                data-icon="inline-start"
              />
            )}
            {loading ? t("common.verifying") : t("common.verify")}
          </Button>
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <h1 className="mb-2 font-heading text-2xl font-medium tracking-[-0.01em]">
          {t("auth.login.title")}
        </h1>
        <CredentialInput
          type="email"
          required
          placeholder={t("common.email")}
          aria-label={t("common.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
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
              icon={Login03Icon}
              size={16}
              data-icon="inline-start"
            />
          )}
          {loading ? t("auth.login.submitting") : t("auth.login.submit")}
        </Button>
        {passkeySupported && (
          <Button
            type="button"
            variant="outline"
            onClick={handlePasskeyLogin}
            disabled={loading}
          >
            <HugeiconsIcon
              icon={FingerPrintIcon}
              size={16}
              data-icon="inline-start"
            />
            {t("auth.login.passkey")}
          </Button>
        )}
        <p className="text-center text-sm text-muted-foreground">
          {t("auth.login.needAccount")}{" "}
          <Link
            href={
              authReturn === "/invitations/accept"
                ? "/signup?next=%2Finvitations%2Faccept"
                : "/signup"
            }
            className="text-foreground underline underline-offset-4 hover:no-underline"
          >
            {t("auth.login.signUp")}
          </Link>
        </p>
        <p className="text-center text-sm text-muted-foreground">
          <Link
            href="/recover"
            className="text-foreground underline underline-offset-4 hover:no-underline"
          >
            {t("auth.login.forgot")}
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}

function LoginFallback() {
  const t = useAppT()
  return (
    <AuthShell>
      <p role="status" className="text-sm text-muted-foreground">
        {t("auth.login.loading")}
      </p>
    </AuthShell>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginPageContent />
    </Suspense>
  )
}
