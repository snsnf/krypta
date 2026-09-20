"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RecoveryCodeCard } from "@/components/recovery-code-card"
import { toast } from "@/components/ui/toast"
import { ApiClientError } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { regenerateRecoveryCode } from "@/lib/recovery"

/**
 * Lets a signed-in user mint a replacement vault recovery code.
 *
 * A recovery code is shown exactly once, at signup. If that screen is closed
 * before it is saved, there was previously no way to get another: the only
 * thing that mints one is completing a recovery, which needs the code the
 * user no longer has. This panel closes that gap, gated behind the same
 * password reauthentication `AccountActions` uses before deleting an account:
 * a session alone must not be enough to mint standing vault access.
 */
export function RecoveryCodePanel() {
  const email = useAuthStore((s) => s.email)
  const accountKey = useAuthStore((s) => s.accountKey)
  const [confirming, setConfirming] = useState(false)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [newCode, setNewCode] = useState<string | null>(null)

  async function regenerate() {
    if (email === null || accountKey === null) return
    setBusy(true)
    try {
      const { recoveryCode } = await regenerateRecoveryCode({
        email,
        password,
        accountKey,
      })
      setNewCode(recoveryCode)
      setConfirming(false)
      setPassword("")
    } catch (err) {
      toast.add({
        title:
          err instanceof ApiClientError
            ? err.message
            : "Could not generate a new code",
        description: "Check your password and try again.",
        type: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  if (newCode) {
    return <RecoveryCodeCard code={newCode} onConfirm={() => setNewCode(null)} />
  }

  if (confirming) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void regenerate()
        }}
        className="flex flex-col items-start gap-3"
      >
        <p className="max-w-prose text-sm text-muted-foreground">
          Enter your password to confirm. The code you saved at signup will
          stop working the moment the new one is issued.
        </p>
        <Input
          required
          autoFocus
          type="password"
          autoComplete="current-password"
          aria-label="Password"
          className="max-w-72"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || !password}>
            {busy ? "Verifying..." : "Generate new code"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              setPassword("")
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="max-w-prose text-sm text-muted-foreground">
        Your vault recovery code was shown once, at signup. If you lost it,
        generate a new one; it will replace the old one immediately, and the
        old one will no longer work.
      </p>
      <Button size="sm" onClick={() => setConfirming(true)}>
        Generate new recovery code
      </Button>
    </div>
  )
}
