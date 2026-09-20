"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  RotateClockwiseIcon,
  ShieldKeyIcon,
  UserAdd01Icon,
} from "@hugeicons/core-free-icons"
import {
  deriveAuthVerifier,
  deriveRecoveryUnlockKey,
  deriveRecoveryVerifier,
  generateAccountKey,
  generateRecoveryCode,
  wrapAccountKey,
} from "@krypta/crypto"
import { apiFetch, ApiClientError } from "@/lib/api"
import { safeAuthReturn } from "@/lib/auth-return"
import { AccountSharingKeyError } from "@/lib/account-sharing-key"
import { ensureSodiumReady } from "@/lib/sodium-ready"
import {
  bootstrapVaultWithUnlockKey,
  deriveVaultUnlockKey,
  retryPendingVault,
} from "@/lib/vault-access"
import { resendControlState } from "@/lib/resend-control"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AuthShell } from "@/components/auth-shell"
import { RecoveryCodeCard } from "@/components/recovery-code-card"
import { useRedirectIfAuthenticated } from "@/hooks/use-redirect-if-authenticated"

function SignupPageContent() {
  const searchParams = useSearchParams()
  const [authReturn] = useState(() => safeAuthReturn(searchParams.get("next")))
  const beginInteractiveAuth = useRedirectIfAuthenticated(authReturn)
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [vaultRetry, setVaultRetry] = useState(false)
  // Set when register succeeds and a mailed code is still outstanding. The
  // unlock key derived from the password is held across the two steps: only
  // the verifier hashed from it is ever sent, and the vault can only be
  // opened once the code clears.
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendLoading, setResendLoading] = useState(false)
  const vaultUserId = useRef<string | null>(null)
  const unlockKey = useRef<string | null>(null)
  // Generated once and reused if the request has to be retried. The server
  // keeps the first material it accepted, so resending freshly generated
  // material would leave the displayed code unable to open anything.
  const accountKey = useRef<string | null>(null)
  const recoveryCodeRef = useRef<string | null>(null)
  // The one place the raw recovery code exists. Never persisted, never logged,
  // and dropped the moment the card is acknowledged.
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    beginInteractiveAuth()
    setError(null)
    setLoading(true)
    try {
      await ensureSodiumReady()
      unlockKey.current = await deriveVaultUnlockKey(email, password)
      const { pending_token } = await apiFetch<{
        verification_required: boolean
        pending_token: string
      }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email,
          verifier: deriveAuthVerifier(unlockKey.current),
        }),
      })
      setPendingToken(pending_token)
      setResendCooldown(60)
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Something went wrong"
      )
    } finally {
      setLoading(false)
    }
  }

  async function completeSignup(userId: string, wrappedAccountKey: string) {
    if (unlockKey.current === null) throw new AccountSharingKeyError()
    vaultUserId.current = userId
    await bootstrapVaultWithUnlockKey(
      userId,
      email,
      unlockKey.current,
      wrappedAccountKey
    )
    // The vault is open, so the code can be shown. Showing it earlier would
    // risk presenting a code for an account that never finished being set up.
    showRecoveryCode()
  }

  // Falls through to the dashboard rather than stranding anyone on a blank
  // step if the code is somehow gone; it is only reachable via this flow.
  function showRecoveryCode() {
    if (recoveryCodeRef.current === null) {
      router.replace(authReturn)
      return
    }
    setRecoveryCode(recoveryCodeRef.current)
  }

  function dismissRecoveryCode() {
    recoveryCodeRef.current = null
    setRecoveryCode(null)
    router.replace(authReturn)
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
      showRecoveryCode()
    } catch {
      setError("Could not initialize your secure vault. Try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setLoading(true)
    try {
      beginInteractiveAuth()
      await ensureSodiumReady()
      if (unlockKey.current === null) throw new AccountSharingKeyError()
      // The account key is generated here, once, and never leaves this device
      // unwrapped. The unlock key wraps only this value; every form key is
      // wrapped under the account key, which is what lets a second unlock
      // method be enrolled later without re-encrypting anything.
      accountKey.current ??= generateAccountKey()
      recoveryCodeRef.current ??= generateRecoveryCode()
      // Only a verifier derived from the code is sent. The code itself, and
      // the unlock key it derives, stay in this browser.
      const recoveryUnlockKey = await deriveRecoveryUnlockKey(
        recoveryCodeRef.current,
        email
      )
      const wrappedAccountKeyPassword = wrapAccountKey(
        accountKey.current,
        unlockKey.current
      )
      const { user_id, wrapped_account_key } = await apiFetch<{
        user_id: string
        wrapped_account_key: string
      }>("/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({
          pending_token: pendingToken,
          code: code.trim(),
          wrapped_account_key_password: wrappedAccountKeyPassword,
          wrapped_account_key_recovery: wrapAccountKey(
            accountKey.current,
            recoveryUnlockKey
          ),
          recovery_verifier: deriveRecoveryVerifier(recoveryUnlockKey),
        }),
      })
      await completeSignup(user_id, wrapped_account_key)
    } catch (err) {
      if (err instanceof AccountSharingKeyError) {
        setVaultRetry(true)
        setError("Could not initialize your secure vault. Try again.")
        return
      }
      setCode("")
      setError(
        err instanceof ApiClientError && err.code === "rate_limited"
          ? "Too many attempts. Wait a minute and try again."
          : "That code was not accepted. Check it and try again."
      )
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    if (resendLoading || resendCooldown > 0) return
    setError(null)
    setNotice(null)
    setResendLoading(true)
    try {
      await apiFetch<{ sent: boolean }>("/auth/resend", {
        method: "POST",
        body: JSON.stringify({ pending_token: pendingToken }),
      })
      setNotice("A new code is on its way.")
      setResendCooldown(60)
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "rate_limited"
          ? "Wait a minute before asking for another code."
          : "Could not send another code."
      )
    } finally {
      setResendLoading(false)
    }
  }

  function startOver() {
    setPendingToken(null)
    // A different address is a different account, so none of the material
    // generated for the abandoned one may be reused.
    accountKey.current = null
    recoveryCodeRef.current = null
    setRecoveryCode(null)
    setCode("")
    setError(null)
    setNotice(null)
    setResendCooldown(0)
    setResendLoading(false)
  }

  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = window.setTimeout(
      () => setResendCooldown((seconds) => Math.max(0, seconds - 1)),
      1000
    )
    return () => window.clearTimeout(timer)
  }, [resendCooldown])

  const resendControl = resendControlState(resendCooldown, resendLoading)

  if (recoveryCode !== null) {
    return (
      <AuthShell>
        <RecoveryCodeCard code={recoveryCode} onConfirm={dismissRecoveryCode} />
      </AuthShell>
    )
  }

  if (vaultRetry) {
    return (
      <AuthShell>
        <form onSubmit={handleVaultRetry} className="flex flex-col gap-4">
          <div className="mb-2">
            <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
              Finish setting up your vault
            </h1>
            <p
              className="mt-1.5 text-sm text-muted-foreground"
              aria-live="polite"
            >
              {error ?? "Could not initialize your secure vault. Try again."}
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
            {loading ? "Trying again..." : "Try again"}
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
              Check your email
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              We sent a 6-digit code to {email}. Your account is created once
              you enter it.
            </p>
          </div>
          <Input
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            placeholder="6-digit code"
            aria-label="Verification code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <p
            className={`text-sm transition-opacity duration-150 ease-out ${
              error
                ? "text-destructive opacity-100"
                : notice
                  ? "text-muted-foreground opacity-100"
                  : "h-0 opacity-0"
            }`}
            aria-live="polite"
          >
            {error ?? notice}
          </p>
          <Button
            type="submit"
            disabled={loading}
            className="transition-transform duration-150 ease-out active:scale-[0.97]"
          >
            {!loading && (
              <HugeiconsIcon
                icon={ShieldKeyIcon}
                size={16}
                data-icon="inline-start"
              />
            )}
            {loading ? "Verifying..." : "Verify"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            <button
              type="button"
              onClick={handleResend}
              disabled={resendControl.disabled}
              className="text-foreground underline underline-offset-4 hover:no-underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
            >
              {resendControl.label}
            </button>
            {" · "}
            <button
              type="button"
              onClick={startOver}
              className="text-foreground underline underline-offset-4 hover:no-underline"
            >
              Use a different address
            </button>
          </p>
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="mb-2">
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            Create an account
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Your password never leaves this device. Only a one-way verifier
            derived from it is sent, and the key it unlocks stays here.
          </p>
        </div>
        <Input
          type="email"
          required
          placeholder="Email"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          required
          minLength={12}
          placeholder="Password (min 12 characters)"
          aria-label="Password"
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
              icon={UserAdd01Icon}
              size={16}
              data-icon="inline-start"
            />
          )}
          {loading ? "Creating account..." : "Sign up"}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href={
              authReturn === "/invitations/accept"
                ? "/login?next=%2Finvitations%2Faccept"
                : "/login"
            }
            className="text-foreground underline underline-offset-4 hover:no-underline"
          >
            Log in
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}

function SignupFallback() {
  return (
    <AuthShell>
      <p role="status" className="text-sm text-muted-foreground">
        Loading sign up…
      </p>
    </AuthShell>
  )
}

export default function SignupPage() {
  return (
    <Suspense fallback={<SignupFallback />}>
      <SignupPageContent />
    </Suspense>
  )
}
