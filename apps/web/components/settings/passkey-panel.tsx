"use client"

import { useEffect, useState } from "react"
import { apiFetch, ApiClientError } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { requestReauthenticationReceipt } from "@/lib/vault-access"
import { useAppFormat, useAppLanguage, useAppT } from "@/lib/app-i18n"
import { describeApiError } from "@/lib/api-error-text"
import { CredentialInput } from "@/components/credential-input"
import {
  enrollPasskey,
  PasskeyStrandedCredentialError,
  PasskeyUnsupportedError,
} from "@/lib/passkey"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/toast"

interface PasskeyRow {
  id: string
  nickname: string | null
  created_at: string | null
  last_used_at: string | null
}

export function PasskeyPanel() {
  const t = useAppT()
  const language = useAppLanguage()
  const format = useAppFormat()
  const formatDate = (value: string | null): string =>
    value === null
      ? t("account.passkeys.never")
      : format.date(value) || t("account.passkeys.unknown")
  const accountKey = useAuthStore((s) => s.accountKey)
  const email = useAuthStore((s) => s.email)
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null)
  const [nickname, setNickname] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  // Checked in an effect, never during render: the server always renders
  // without this button, and reading window.PublicKeyCredential at render
  // time would make the client's first render disagree with it, failing
  // hydration. Mirrors the same check on the login page.
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

  async function refresh() {
    const { passkeys } = await apiFetch<{ passkeys: PasskeyRow[] }>(
      "/auth/passkeys"
    )
    setPasskeys(passkeys)
  }

  useEffect(() => {
    let cancelled = false
    apiFetch<{ passkeys: PasskeyRow[] }>("/auth/passkeys")
      .then(({ passkeys }) => {
        if (!cancelled) setPasskeys(passkeys)
      })
      .catch(() => {
        // useEnsureUnlocked already handles a dead session. Leaving the list
        // hidden beats rendering it in the wrong state.
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!accountKey || !email || !passkeySupported) return
    setBusy(true)
    try {
      const receipt = await requestReauthenticationReceipt(email, password)
      setPassword("")
      await enrollPasskey(
        accountKey,
        nickname.trim() || t("account.passkeys.defaultName"),
        receipt
      )
      setNickname("")
      await refresh()
      toast.add({ title: t("account.passkeys.added") })
    } catch (err) {
      if (err instanceof PasskeyUnsupportedError) {
        // Say what actually happened. The credential exists on the device even
        // though we registered nothing, and no web API can remove it, so a
        // vague message turns into a support question nobody can answer.
        toast.add({
          title: t("account.passkeys.noKeyStorage"),
          description: t("account.passkeys.noKeyStorageBody"),
          type: "error",
        })
      } else if (err instanceof PasskeyStrandedCredentialError) {
        // The first prompt was already accepted, so a credential exists on
        // the device even though the cancel happened at the second one. Say
        // so plainly rather than reporting a clean cancel.
        toast.add({
          title: t("account.passkeys.stranded"),
          description: t("account.passkeys.strandedBody"),
          type: "error",
        })
      } else if (err instanceof ApiClientError && err.code === "unauthorized") {
        toast.add({
          title: t("account.twoFactor.passwordRejected"),
          type: "error",
        })
      } else if (
        err instanceof DOMException &&
        err.name === "NotAllowedError"
      ) {
        toast.add({ title: t("account.passkeys.cancelled") })
      } else {
        toast.add({
          title:
            err instanceof ApiClientError
              ? describeApiError(err, t, language)
              : t("account.passkeys.addFailed"),
          type: "error",
        })
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiFetch(`/auth/passkeys/${id}`, { method: "DELETE" })
      await refresh()
      toast.add({ title: t("account.passkeys.removed") })
    } catch {
      toast.add({ title: t("account.passkeys.removeFailed"), type: "error" })
    }
  }

  // The heading lives in the settings page alongside every other section's,
  // so the icon and type scale stay in one place rather than drifting here.
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("account.passkeys.intro")}
      </p>

      {passkeys?.length ? (
        <ul className="divide-y rounded-md border">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="flex items-center justify-between gap-4 p-3"
            >
              <div className="min-w-0">
                <p dir="auto" className="truncate text-sm font-medium">
                  {passkey.nickname ?? t("account.passkeys.defaultName")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("account.passkeys.usage", {
                    created: formatDate(passkey.created_at),
                    used: formatDate(passkey.last_used_at),
                  })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(passkey.id)}
              >
                {t("common.remove")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <form onSubmit={handleAdd} className="flex flex-wrap gap-2">
        <Input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          dir="auto"
          placeholder={t("account.passkeys.nameDevice")}
          aria-label={t("account.passkeys.nameDevice")}
          maxLength={64}
          className="min-w-40 flex-1"
        />
        <CredentialInput
          required
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("account.passkeys.passwordPlaceholder")}
          aria-label={t("account.passkeys.passwordLabel")}
          className="min-w-40 flex-1"
        />
        <Button
          type="submit"
          disabled={busy || !accountKey || !passkeySupported}
        >
          {busy ? t("account.passkeys.waiting") : t("account.passkeys.add")}
        </Button>
      </form>
      {!accountKey ? (
        <p className="text-xs text-muted-foreground">
          {t("account.passkeys.unlockFirst")}
        </p>
      ) : !passkeySupported ? (
        <p className="text-xs text-muted-foreground">
          {t("account.passkeys.unsupported")}
        </p>
      ) : null}
    </div>
  )
}
