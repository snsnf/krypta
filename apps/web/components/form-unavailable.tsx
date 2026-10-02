"use client"

import type { FormTheme } from "@krypta/crypto"
import Link from "next/link"
import { FormThemeSurface } from "@/components/form-theme-surface"
import { KryptaLogo } from "@/components/krypta-logo"
import { useAppT } from "@/lib/app-i18n"
import { failureText, type FormLoadFailure } from "@/lib/form-load-failure"
import type { FormRenderMode } from "@/lib/form-theme"

interface FormUnavailableProps {
  failure: FormLoadFailure
  theme: FormTheme
  mode?: FormRenderMode
}

/**
 * The public form's failure state, in the same card the closed and submitted
 * states use, so a respondent sees one visual language whatever happens. The
 * theme is the default one: a form that failed to load has no theme of its
 * own yet.
 */
export function FormUnavailable({
  failure,
  theme,
  mode = "light",
}: FormUnavailableProps) {
  // Under /f the app language is pinned to English, so a respondent's error
  // page never takes the viewer's language; the form's own language is not
  // known here, the form did not load.
  const t = useAppT()
  const { title, description } = failureText(t, failure)
  return (
    <FormThemeSurface
      theme={theme}
      mode={mode}
      className="flex min-h-svh flex-col items-center justify-center px-4 text-center"
    >
      <div
        role="alert"
        className="w-full max-w-xl rounded-2xl border border-border bg-card p-8"
      >
        <div className="form-theme-accent-bg mx-auto mb-5 h-1.5 w-12 rounded-full opacity-60" />
        <h1 className="form-theme-header font-medium text-balance">
          {title}
        </h1>
        <p className="form-theme-text mt-3 text-pretty text-muted-foreground">
          {description}
        </p>
        {failure.retryable && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="form-theme-button form-theme-accent-bg mt-6 inline-flex h-10 items-center justify-center rounded-full px-5 text-sm font-medium"
          >
            {t("common.tryAgain")}
          </button>
        )}
      </div>
      <Link
        href="/"
        className="mt-8 inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <KryptaLogo className="h-3.5 w-auto" />
        <span>Encrypted forms by krypta</span>
      </Link>
    </FormThemeSurface>
  )
}
