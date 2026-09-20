"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { CheckmarkCircle02Icon, Copy01Icon } from "@hugeicons/core-free-icons"
import { apiFetch, ApiClientError } from "@/lib/api"
import { syncCurrentSessionTotpMetadata, useAuthStore } from "@/lib/auth-store"
import { requestReauthenticationReceipt } from "@/lib/vault-access"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/toast"

interface Setup {
  provisioning_uri: string
  qr_data_uri: string
}

interface TwoFactorPanelProps {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
}

export function TwoFactorPanel({
  enabled,
  onEnabledChange,
}: TwoFactorPanelProps) {
  const email = useAuthStore((s) => s.email)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [code, setCode] = useState("")
  // Turning a factor on takes the password as well as a code: from a stolen
  // session alone it would add a gate that locks the real owner out.
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  // Shown once after enrolling. Kept in state rather than refetched because the
  // server cannot return them again: only their hashes are stored.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [disabling, setDisabling] = useState(false)

  async function startSetup() {
    setBusy(true)
    try {
      setSetup(await apiFetch<Setup>("/auth/2fa/setup", { method: "POST" }))
    } catch {
      toast.add({ title: "Could not start setup", type: "error" })
    } finally {
      setBusy(false)
    }
  }

  async function confirmSetup(e: React.FormEvent) {
    e.preventDefault()
    if (email === null) return
    setBusy(true)
    try {
      const receipt = await requestReauthenticationReceipt(email, password)
      const { recovery_codes } = await apiFetch<{ recovery_codes: string[] }>(
        "/auth/2fa/enable",
        {
          method: "POST",
          body: JSON.stringify({
            code: code.trim(),
            reauthentication_receipt: receipt,
          }),
        }
      )
      setRecoveryCodes(recovery_codes)
      setSetup(null)
      setCode("")
      setPassword("")
      onEnabledChange(true)
      syncCurrentSessionTotpMetadata(true)
    } catch (err) {
      toast.add({
        title:
          err instanceof ApiClientError && err.code === "unauthorized"
            ? "Your password was not accepted"
            : err instanceof ApiClientError
              ? err.message
              : "Could not enable two-factor authentication",
        type: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  async function confirmDisable(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await apiFetch("/auth/2fa/disable", {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      })
      setDisabling(false)
      setCode("")
      onEnabledChange(false)
      syncCurrentSessionTotpMetadata(false)
      toast.add({ title: "Two-factor authentication turned off" })
    } catch (err) {
      toast.add({
        title:
          err instanceof ApiClientError ? err.message : "Could not turn it off",
        type: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  // The one moment these codes are visible, so it takes over the panel rather
  // than sitting alongside anything that invites navigating away.
  if (recoveryCodes) {
    return (
      <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-4">
        <h3 className="text-sm font-medium">Save your recovery codes</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Each code works once, and this is the only time they are shown. Store
          them somewhere other than your authenticator app.
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(recoveryCodes.join("\n"))
              toast.add({ title: "Codes copied", type: "success" })
            } catch {
              toast.add({
                title: "Could not copy",
                description: "Select the codes and copy them manually.",
                type: "error",
              })
            }
          }}
        >
          <HugeiconsIcon icon={Copy01Icon} size={14} data-icon="inline-start" />
          Copy codes
        </Button>
        <Button
          size="sm"
          className="mt-4 ml-2"
          onClick={() => setRecoveryCodes(null)}
        >
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={14}
            data-icon="inline-start"
          />
          I have saved them
        </Button>
      </div>
    )
  }

  if (setup) {
    return (
      <form onSubmit={confirmSetup} className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          Scan this with your authenticator app, then enter the code it shows
          and your password.
        </p>
        {/* Rendered by the API, so no QR library ships to the browser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={setup.qr_data_uri}
          alt="Two-factor setup QR code"
          className="size-40 rounded-lg border border-border bg-white p-1"
        />
        <details className="text-sm">
          <summary className="text-muted-foreground">
            Cannot scan the code?
          </summary>
          <code className="mt-2 block max-w-md text-xs break-all text-muted-foreground">
            {setup.provisioning_uri}
          </code>
        </details>
        <Input
          required
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          aria-label="Code from your authenticator app"
          className="max-w-40"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Input
          required
          type="password"
          autoComplete="current-password"
          placeholder="Your password"
          aria-label="Your password, to turn on two-factor authentication"
          className="max-w-72"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Verifying..." : "Turn on"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setSetup(null)
              setCode("")
              setPassword("")
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  if (disabling) {
    return (
      <form
        onSubmit={confirmDisable}
        className="flex flex-col items-start gap-3"
      >
        <p className="max-w-prose text-sm text-muted-foreground">
          Enter a code from your authenticator app, or a recovery code, to turn
          two-factor authentication off.
        </p>
        <Input
          required
          autoFocus
          autoComplete="one-time-code"
          placeholder="123456"
          aria-label="Code to confirm turning off two-factor authentication"
          className="max-w-40"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="destructive" size="sm" disabled={busy}>
            {busy ? "Turning off..." : "Turn off"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDisabling(false)
              setCode("")
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
        {enabled
          ? "A code from your authenticator app is required to sign in. Your responses stay encrypted either way; this protects the account itself."
          : "Require a code from an authenticator app when signing in, so a stolen password is not enough on its own."}
      </p>
      {enabled ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDisabling(true)}
        >
          Turn off two-factor authentication
        </Button>
      ) : (
        <Button size="sm" onClick={startSetup} disabled={busy}>
          {busy ? "Preparing..." : "Set up two-factor authentication"}
        </Button>
      )}
    </div>
  )
}
