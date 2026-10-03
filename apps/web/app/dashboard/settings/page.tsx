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
import { useAppT } from "@/lib/app-i18n"
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
  const t = useAppT()
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
        title: t("account.signOutFailed"),
        description: t("account.signOutFailedBody"),
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
          {t("account.title")}
        </h1>

        <section className="mt-8">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={UserCircleIcon} size={15} />
            {t("account.signedInAs")}
          </h2>
          <p
            dir="ltr"
            className="mt-1 text-start text-sm text-muted-foreground"
          >
            {email ?? " "}
          </p>
        </section>

        <PlanPanel />

        <Separator className="my-8" />

        <section>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={ShieldKeyIcon} size={15} />
            {t("account.twoFactorHeading")}
          </h2>
          <div className="mt-3">
            {totpEnabled === null ? (
              <p className="text-sm text-muted-foreground">
                {t("account.checking")}
              </p>
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
            {t("account.passkeysHeading")}
          </h2>
          <div className="mt-3">
            <PasskeyPanel />
          </div>
        </section>

        <Separator className="my-8" />

        <section>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={RefreshIcon} size={15} />
            {t("account.recoveryHeading")}
          </h2>
          <div className="mt-3">
            <RecoveryCodePanel />
          </div>
        </section>

        <Separator className="my-8" />

        <section>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={SmartPhone01Icon} size={15} />
            {t("account.sessionsHeading")}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t("account.sessionsBody")}
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
              {t("account.signOutEverywhere")}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {t("account.signOutEverywhereQuestion")}
                </DialogTitle>
                <DialogDescription>
                  {t("account.signOutDescription")}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" size="sm" />}>
                  {t("common.cancel")}
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
                  {signingOut
                    ? t("account.signingOut")
                    : t("account.signOutEverywhere")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      </main>
    </div>
  )
}
