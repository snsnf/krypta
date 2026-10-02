"use client"

import Link from "next/link"
import { AppHeader } from "@/components/app-header"
import { Button } from "@/components/ui/button"
import { useAppT } from "@/lib/app-i18n"
import { failureText, type FormLoadFailure } from "@/lib/form-load-failure"

interface WorkspaceUnavailableProps {
  failure: FormLoadFailure
  /** Hidden on the dashboard itself, where it would link to the page you are on. */
  showDashboardLink?: boolean
}

/**
 * The signed-in counterpart of FormUnavailable: the same explanation shape,
 * inside the app header so the person keeps their bearings and can leave.
 */
export function WorkspaceUnavailable({
  failure,
  showDashboardLink = true,
}: WorkspaceUnavailableProps) {
  const t = useAppT()
  const { title, description } = failureText(t, failure)
  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader />
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div
          role="alert"
          className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center"
        >
          <div className="mx-auto mb-5 h-1.5 w-12 rounded-full bg-primary/40" />
          <h1 className="font-heading text-xl font-medium tracking-[-0.01em] text-balance">
            {title}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-pretty text-muted-foreground">
            {description}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {failure.retryable && (
              <Button type="button" onClick={() => window.location.reload()}>
                {t("common.tryAgain")}
              </Button>
            )}
            {showDashboardLink && (
              <Button
                variant={failure.retryable ? "outline" : "default"}
                render={<Link href="/dashboard" />}
                nativeButton={false}
              >
                {t("failure.backToForms")}
              </Button>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
