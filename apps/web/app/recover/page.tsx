"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AccountRecoveryIcon,
  ArrowLeft01Icon,
  Key01Icon,
  LockKeyIcon,
} from "@hugeicons/core-free-icons"
import { normalizeBase32 } from "@krypta/crypto"
import { ApiClientError } from "@/lib/api"
import { completeRecovery, startRecovery, verifyRecovery } from "@/lib/recovery"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AuthShell } from "@/components/auth-shell"
import { RecoveryCodeCard } from "@/components/recovery-code-card"

const RECOVERY_CODE_CHARS = 32
const RECOVERY_CODE_GROUP = 4

/**
 * Normalizes as the user types: uppercases, folds the visually confusable
 * characters (I/L to 1, O to 0), and re-groups into fours, so a lowercase,
 * unhyphenated, or O-for-0 transcription is accepted without the user having
 * to notice.
 */
function formatRecoveryCodeInput(raw: string): string {
  const normalized = normalizeBase32(raw).slice(0, RECOVERY_CODE_CHARS)
  return (
    normalized.match(new RegExp(`.{1,${RECOVERY_CODE_GROUP}}`, "g")) ?? []
  ).join("-")
}

type Step = "email" | "verify" | "password" | "recoveryCode"

// One message for a wrong emailed code, a wrong recovery code, and a wrong
// TOTP code. The API deliberately makes them indistinguishable, and the UI
// must not undo that.
const GENERIC_VERIFY_FAILURE =
  "That combination wasn't accepted. Check both codes and try again."

export default function RecoverPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>("email")
  const [email, setEmail] = useState("")
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [emailCode, setEmailCode] = useState("")
  const [recoveryCode, setRecoveryCode] = useState("")
  // Always visible and optional. The API never tells the browser in advance
  // whether an account has TOTP enrolled: every recover/verify failure is
  // deliberately indistinguishable from every other, so there is no signal
  // to gate this on. Showing it unconditionally costs nothing: its presence
  // is identical for every account, and hiding it until a first failed
  // attempt would burn one of the five allowed attempts on a request that
  // could never have succeeded, which is the wrong trade to make on a flow
  // someone is already using under stress.
  const [totpCode, setTotpCode] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const accountKey = useRef<string | null>(null)

  async function handleStart(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const { pendingToken } = await startRecovery(email)
      setPendingToken(pendingToken)
      setStep("verify")
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Something went wrong"
      )
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (pendingToken === null) return
    setError(null)
    setLoading(true)
    try {
      const { accountKey: key } = await verifyRecovery({
        pendingToken,
        email,
        emailCode: emailCode.trim(),
        recoveryCode,
        totpCode: totpCode.trim() ? totpCode.trim() : undefined,
      })
      accountKey.current = key
      setStep("password")
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "rate_limited"
          ? "Too many attempts. Wait a minute and try again."
          : GENERIC_VERIFY_FAILURE
      )
    } finally {
      setLoading(false)
    }
  }

  async function handleComplete(e: React.FormEvent) {
    e.preventDefault()
    if (accountKey.current === null) return
    setError(null)
    setLoading(true)
    try {
      const { recoveryCode: freshCode } = await completeRecovery({
        email,
        accountKey: accountKey.current,
        newPassword,
      })
      setNewRecoveryCode(freshCode)
      setStep("recoveryCode")
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Something went wrong"
      )
    } finally {
      setLoading(false)
    }
  }

  function startOver() {
    setStep("email")
    setPendingToken(null)
    setEmailCode("")
    setRecoveryCode("")
    setTotpCode("")
    setNewPassword("")
    accountKey.current = null
    setError(null)
  }

  if (step === "recoveryCode" && newRecoveryCode !== null) {
    return (
      <AuthShell>
        <RecoveryCodeCard
          code={newRecoveryCode}
          onConfirm={() => router.replace("/login")}
        />
      </AuthShell>
    )
  }

  if (step === "password") {
    return (
      <AuthShell>
        <form onSubmit={handleComplete} className="flex flex-col gap-4">
          <div className="mb-2">
            <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
              Set a new password
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Your existing forms and responses stay exactly as they are. A new
              recovery code is issued once this is done, and the old one stops
              working.
            </p>
          </div>
          <Input
            type="password"
            required
            autoFocus
            minLength={12}
            placeholder="New password (min 12 characters)"
            aria-label="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
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
                icon={LockKeyIcon}
                size={16}
                data-icon="inline-start"
              />
            )}
            {loading ? "Setting password..." : "Set new password"}
          </Button>
        </form>
      </AuthShell>
    )
  }

  if (step === "verify") {
    return (
      <AuthShell>
        <form onSubmit={handleVerify} className="flex flex-col gap-4">
          <div className="mb-2">
            <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
              Enter your codes
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Enter the 6-digit code we emailed to {email} and your printed
              recovery code.
            </p>
          </div>
          <Input
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            placeholder="6-digit email code"
            aria-label="Emailed code"
            value={emailCode}
            onChange={(e) => setEmailCode(e.target.value)}
          />
          <Input
            required
            inputMode="text"
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            aria-label="Recovery code"
            className="font-mono"
            value={recoveryCode}
            onChange={(e) =>
              setRecoveryCode(formatRecoveryCodeInput(e.target.value))
            }
          />
          <div className="flex flex-col gap-1">
            <Input
              autoComplete="one-time-code"
              inputMode="text"
              placeholder="Authenticator code"
              aria-label="Authenticator code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Only if you have two-factor authentication enabled.
            </p>
          </div>
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
                icon={Key01Icon}
                size={16}
                data-icon="inline-start"
              />
            )}
            {loading ? "Verifying..." : "Verify"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            <button
              type="button"
              onClick={startOver}
              className="text-foreground underline underline-offset-4 hover:no-underline"
            >
              Start over
            </button>
          </p>
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={handleStart} className="flex flex-col gap-4">
        <div className="mb-2">
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            Recover your vault
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            You&apos;ll need the recovery code you saved when you created your
            account. Without it, this will not work: there is no other way to
            recover an encrypted vault.
          </p>
        </div>
        <Input
          type="email"
          required
          autoFocus
          placeholder="Email"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
              icon={AccountRecoveryIcon}
              size={16}
              data-icon="inline-start"
            />
          )}
          {loading ? "Sending..." : "Send recovery code"}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          <Link
            href="/login"
            className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:no-underline"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
            Back to log in
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}
