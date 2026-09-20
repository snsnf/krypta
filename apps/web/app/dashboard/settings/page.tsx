"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FingerPrintIcon,
  Logout03Icon,
  RefreshIcon,
  ShieldKeyIcon,
  SmartPhone01Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons"
import { apiFetch } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { clearPersistedAccountKey } from "@/lib/device-key"
import { useEnsureUnlocked } from "@/hooks/use-ensure-unlocked"
import { AppHeader } from "@/components/app-header"
import { PasskeyPanel } from "@/components/settings/passkey-panel"
import { PlanPanel } from "@/components/settings/plan-panel"
import { RecoveryCodePanel } from "@/components/settings/recovery-code-panel"
import { TwoFactorPanel } from "@/components/settings/two-factor-panel"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { toast } from "@/components/ui/toast"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export default function AccountSettingsPage() {
  useEnsureUnlocked()
  const email = useAuthStore((s) => s.email)
  const userId = useAuthStore((s) => s.userId)
  const clear = useAuthStore((s) => s.clear)
  const [signingOut, setSigningOut] = useState(false)
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch<{ totp_enabled: boolean }>("/auth/me")
      .then((me) => {
        if (!cancelled) setTotpEnabled(me.totp_enabled)
      })
      .catch(() => {
        // useEnsureUnlocked already handles a dead session; leaving the panel
        // hidden is better than rendering a control in the wrong state.
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSignOutEverywhere() {
    setSigningOut(true)
    try {
      await apiFetch("/auth/logout-all", { method: "POST" })
    } catch {
      // Leaving the user here with a possibly-dead session helps no one, but a
      // failure means sessions may still be live, so say so rather than
      // pretending it worked.
      setSigningOut(false)
      toast.add({
        title: "Could not sign out everywhere",
        description: "Your other sessions may still be active. Try again.",
        type: "error",
      })
      return
    }

    // This revokes the current session too, so the only coherent destination is
    // the login page. No success toast: it would unmount before being read.
    if (userId) {
      await clearPersistedAccountKey(userId)
    }
    clear()
    window.location.href = "/login"
  }

  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          Account
        </h1>

        <section className="mt-8">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={UserCircleIcon} size={15} />
            Signed in as
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {email ?? " "}
          </p>
        </section>

        <PlanPanel />

        <Separator className="my-8" />

        <section>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={ShieldKeyIcon} size={15} />
            Two-factor authentication
          </h2>
          <div className="mt-3">
            {totpEnabled === null ? (
              <p className="text-sm text-muted-foreground">Checking...</p>
            ) : (
              <TwoFactorPanel
                enabled={totpEnabled}
                onEnabledChange={setTotpEnabled}
              />
            )}
          </div>
        </section>

        <Separator className="my-8" />

        <section>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={FingerPrintIcon} size={15} />
            Passkeys
          </h2>
          <div className="mt-3">
            <PasskeyPanel />
          </div>
        </section>

        <Separator className="my-8" />

        <section>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={RefreshIcon} size={15} />
            Vault recovery code
          </h2>
          <div className="mt-3">
            <RecoveryCodePanel />
          </div>
        </section>

        <Separator className="my-8" />

        <section>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={SmartPhone01Icon} size={15} />
            Sessions
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Signing out everywhere ends every session on every device,
            including this one. Use it if you think someone else has access to
            your account.
          </p>

          <Dialog>
            <DialogTrigger
              render={
                <Button variant="destructive" size="sm" className="mt-4" />
              }
            >
              <HugeiconsIcon
                icon={Logout03Icon}
                size={16}
                data-icon="inline-start"
              />
              Sign out everywhere
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Sign out everywhere?</DialogTitle>
                <DialogDescription>
                  Every device will be signed out, including this one, and you
                  will need your password to get back in. Your forms and
                  responses are not affected.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" size="sm" />}>
                  Cancel
                </DialogClose>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={signingOut}
                  onClick={handleSignOutEverywhere}
                >
                  {!signingOut && (
                    <HugeiconsIcon
                      icon={Logout03Icon}
                      size={16}
                      data-icon="inline-start"
                    />
                  )}
                  {signingOut ? "Signing out..." : "Sign out everywhere"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      </main>
    </div>
  )
}
