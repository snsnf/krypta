"use client"

import { useEffect, useState, type ReactNode } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ClipboardIcon,
  Pulse01Icon,
  Settings02Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons"
import { AppHeader } from "@/components/app-header"
import { Separator } from "@/components/ui/separator"
import { canOpenAdmin, type AdminMe } from "@/lib/admin"
import { apiFetch } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"

interface AdminSessionMe extends AdminMe {
  user_id: string
  email: string
}

const navigation = [
  { href: "/admin", label: "Accounts", icon: UserMultiple02Icon },
  { href: "/admin/instance", label: "Instance", icon: Settings02Icon },
  { href: "/admin/audit", label: "Audit", icon: ClipboardIcon },
  { href: "/admin/health", label: "Health", icon: Pulse01Icon },
]

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const setSession = useAuthStore((state) => state.setSession)
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    let cancelled = false

    apiFetch<AdminSessionMe>("/auth/me")
      .then((me) => {
        if (cancelled) return
        setSession({
          userId: me.user_id,
          email: me.email,
          instanceAdmin: me.instance_admin,
          totpEnabled: me.totp_enabled,
          totpVerified: me.second_factor_verified,
        })
        if (!canOpenAdmin(me)) {
          router.replace("/dashboard")
          return
        }
        setAllowed(true)
      })
      .catch(() => {
        if (!cancelled) router.replace("/dashboard")
      })

    return () => {
      cancelled = true
    }
  }, [router, setSession])

  if (!allowed) {
    return <div className="min-h-svh bg-background" aria-busy="true" />
  }

  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader />
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:gap-10 lg:py-8">
        {/*
         * Sticky from the large breakpoint up, where the nav sits beside the
         * content: the audit log and the account list both run far past one
         * screen, and losing the nav on the way down means scrolling back up
         * to change section.
         *
         * `self-start` is what makes it work. A flex row stretches its items
         * to full height by default, and a sticky element that is already as
         * tall as its container has nowhere to travel, so it silently does
         * nothing. The offset clears the sticky header rather than sliding
         * under it. Below `lg` the nav is a horizontal row above the content
         * and stays in the flow.
         */}
        <aside className="w-full shrink-0 lg:sticky lg:top-[4.5rem] lg:w-40 lg:self-start">
          <p className="font-heading text-lg font-medium tracking-[-0.01em]">
            Administration
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Instance metadata only
          </p>
          <Separator className="my-4 lg:hidden" />
          <nav
            aria-label="Administration"
            className="flex gap-1 lg:mt-5 lg:flex-col"
          >
            {navigation.map((item) => {
              const active = pathname === item.href
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ease-out ${
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <HugeiconsIcon icon={item.icon} size={15} />
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
