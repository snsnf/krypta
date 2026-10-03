"use client"

import { useEffect, type ReactNode } from "react"
import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ComputerIcon,
  Logout03Icon,
  Moon02Icon,
  Sun02Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons"
import { useTheme } from "next-themes"
import { apiFetch } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { clearPersistedAccountKey } from "@/lib/device-key"
import { KryptaLogo } from "@/components/krypta-logo"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  LanguageMenu,
  LanguageRadioItems,
} from "@/components/language-switcher"
import { useAppT } from "@/lib/app-i18n"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface AppHeaderProps {
  formName?: string
  actions?: ReactNode
}

export function AppHeader({ formName, actions }: AppHeaderProps) {
  const userId = useAuthStore((s) => s.userId)
  const instanceAdmin = useAuthStore((s) => s.instanceAdmin)
  const totpEnabled = useAuthStore((s) => s.totpEnabled)
  const totpVerified = useAuthStore((s) => s.totpVerified)
  const setAdminMetadata = useAuthStore((s) => s.setAdminMetadata)
  const clear = useAuthStore((s) => s.clear)
  const { theme, setTheme } = useTheme()
  const t = useAppT()

  useEffect(() => {
    if (
      userId === null ||
      instanceAdmin !== null ||
      totpEnabled !== null ||
      totpVerified !== null
    ) {
      return
    }

    let cancelled = false
    apiFetch<{
      instance_admin: boolean
      totp_enabled: boolean
      second_factor_verified: boolean
    }>("/auth/me")
      .then((me) => {
        if (!cancelled) {
          setAdminMetadata({
            userId,
            instanceAdmin: me.instance_admin,
            totpEnabled: me.totp_enabled,
            totpVerified: me.second_factor_verified,
          })
        }
      })
      .catch(() => {
        // The server remains authoritative. Leave the link hidden if session
        // metadata cannot be refreshed.
      })

    return () => {
      cancelled = true
    }
  }, [instanceAdmin, setAdminMetadata, totpEnabled, totpVerified, userId])

  async function handleLogout() {
    try {
      await apiFetch("/auth/logout", { method: "POST" })
    } catch {
      // Best-effort: still clear local state and redirect even if the request itself failed
      // (e.g. offline): staying "logged in" client-side with a dead session helps no one.
    }
    if (userId) {
      await clearPersistedAccountKey(userId)
    }
    clear()
    window.location.href = "/login"
  }

  const showAdmin =
    instanceAdmin === true && totpEnabled === true && totpVerified === true

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-2 py-3 sm:gap-3 sm:px-4">
        <Link
          href="/dashboard"
          aria-label={t("header.home")}
          className="flex shrink-0 items-center gap-2 font-heading text-base font-medium tracking-tight transition-opacity duration-150 ease-out hover:opacity-70"
        >
          <KryptaLogo className="h-6 w-auto text-brand" />
          krypta
        </Link>
        {formName !== undefined && (
          <>
            <div
              aria-hidden="true"
              className="hidden h-4 w-px shrink-0 bg-border min-[420px]:block"
            />
            <p
              dir="auto"
              className="hidden min-w-0 flex-1 truncate text-sm font-medium min-[420px]:block"
            >
              {formName || t("header.untitled")}
            </p>
          </>
        )}
        <div className="ms-auto flex shrink-0 items-center gap-1 sm:gap-3">
          {actions}
          {/*
           * Below sm the header has room for the form's own actions and one
           * more control, so the account items fold into a menu. Above it,
           * the same items sit inline as before; the two are never both
           * rendered visibly, so a test at either width sees one of each.
           */}
          <div className="hidden items-center gap-3 sm:flex">
            <ThemeToggle />
            <LanguageMenu />
            <Link
              href="/dashboard/settings"
              className="text-sm text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
            >
              {t("header.account")}
            </Link>
            {showAdmin && (
              <a
                // A full page load: /admin is English only, so it must not inherit this
                // page's language or direction.
                href="/admin"
                className="text-sm text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
              >
                {t("header.admin")}
              </a>
            )}
            <button
              type="button"
              onClick={handleLogout}
              aria-label={t("header.logOut")}
              className="flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
            >
              <HugeiconsIcon icon={Logout03Icon} size={14} />
              {t("header.logOut")}
            </button>
          </div>
          <div className="sm:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t("header.accountMenu")}
                  />
                }
              >
                <HugeiconsIcon icon={UserCircleIcon} size={18} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem render={<Link href="/dashboard/settings" />}>
                  {t("header.account")}
                </DropdownMenuItem>
                {showAdmin && (
                  <DropdownMenuItem render={<a href="/admin" />}>
                    {t("header.admin")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={theme ?? "system"}
                  onValueChange={(value) => setTheme(String(value))}
                >
                  <DropdownMenuRadioItem value="light">
                    <HugeiconsIcon icon={Sun02Icon} size={14} />
                    {t("header.light")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <HugeiconsIcon icon={ComputerIcon} size={14} />
                    {t("header.system")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <HugeiconsIcon icon={Moon02Icon} size={14} />
                    {t("header.dark")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <LanguageRadioItems />
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void handleLogout()}>
                  <HugeiconsIcon icon={Logout03Icon} size={14} />
                  {t("header.logOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </header>
  )
}
