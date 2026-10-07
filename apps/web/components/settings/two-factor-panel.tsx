"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { CheckmarkCircle02Icon, Copy01Icon } from "@hugeicons/core-free-icons"
import { apiFetch, ApiClientError } from "@/lib/api"
import { syncCurrentSessionTotpMetadata, useAuthStore } from "@/lib/auth-store"
import { requestReauthenticationReceipt } from "@/lib/vault-access"
import { useAppLanguage, useAppT } from "@/lib/app-i18n"
import { describeApiError } from "@/lib/api-error-text"
import { CredentialInput } from "@/components/credential-input"
import { Button } from "@/components/ui/button"
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
  const t = useAppT()
  const language = useAppLanguage()
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
      toast.add({ title: t("account.twoFactor.startFailed"), type: "error" })
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
            ? t("account.twoFactor.passwordRejected")
            : err instanceof ApiClientError
              ? describeApiError(err, t, language)
              : t("account.twoFactor.enableFailed"),
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
      toast.add({ title: t("account.twoFactor.turnedOff") })
    } catch (err) {
      toast.add({
        title:
          err instanceof ApiClientError
            ? describeApiError(err, t, language)
            : t("account.twoFactor.disableFailed"),
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
        <h3 className="text-sm font-medium">
          {t("account.twoFactor.saveCodesTitle")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("account.twoFactor.saveCodesBody")}
        </p>
        <ul
          dir="ltr"
          className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm"
        >
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
              toast.add({
                title: t("account.twoFactor.codesCopied"),
                type: "success",
              })
            } catch {
              toast.add({
                title: t("common.copyFailed"),
                description: t("account.twoFactor.copyFailedBody"),
                type: "error",
              })
            }
          }}
        >
          <HugeiconsIcon icon={Copy01Icon} size={14} data-icon="inline-start" />
          {t("account.twoFactor.copyCodes")}
        </Button>
        <Button
          size="sm"
          className="ms-2 mt-4"
          onClick={() => setRecoveryCodes(null)}
        >
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={14}
            data-icon="inline-start"
          />
          {t("account.twoFactor.saved")}
        </Button>
      </div>
    )
  }

  if (setup) {
    return (
      <form onSubmit={confirmSetup} className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          {t("account.twoFactor.scan")}
        </p>
        {/* Rendered by the API, so no QR library ships to the browser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={setup.qr_data_uri}
          alt={t("account.twoFactor.qrAlt")}
          className="size-40 rounded-lg border border-border bg-white p-1"
        />
        <details className="text-sm">
          <summary className="text-muted-foreground">
            {t("account.twoFactor.cannotScan")}
          </summary>
          <code
            dir="ltr"
            className="mt-2 block max-w-md text-xs break-all text-muted-foreground"
          >
            {setup.provisioning_uri}
          </code>
        </details>
        <CredentialInput
          required
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          aria-label={t("account.twoFactor.codeLabel")}
          className="max-w-40"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <CredentialInput
          required
          type="password"
          autoComplete="current-password"
          placeholder={t("common.yourPassword")}
          aria-label={t("account.twoFactor.passwordLabel")}
          className="max-w-72"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? t("common.verifying") : t("account.twoFactor.turnOn")}
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
            {t("common.cancel")}
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
          {t("account.twoFactor.disablePrompt")}
        </p>
        <CredentialInput
          required
          autoFocus
          autoComplete="one-time-code"
          placeholder="123456"
          aria-label={t("account.twoFactor.disableCodeLabel")}
          className="max-w-40"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="destructive" size="sm" disabled={busy}>
            {busy
              ? t("account.twoFactor.turningOff")
              : t("account.twoFactor.turnOff")}
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
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="max-w-prose text-sm text-muted-foreground">
        {enabled
          ? t("account.twoFactor.enabledBody")
          : t("account.twoFactor.disabledBody")}
      </p>
      {enabled ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDisabling(true)}
        >
          {t("account.twoFactor.turnOffButton")}
        </Button>
      ) : (
        <Button size="sm" onClick={startSetup} disabled={busy}>
          {busy
            ? t("account.twoFactor.preparing")
            : t("account.twoFactor.setUp")}
        </Button>
      )}
    </div>
  )
}
