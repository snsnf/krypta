"use client"

import { cn } from "@/lib/utils"
import { useAppT } from "@/lib/app-i18n"

interface SpinnerProps {
  className?: string
  /** Announced to screen readers, which cannot see a spinning ring. */
  label?: string
}

/**
 * A CSS ring rather than a spinning icon: it inherits `currentColor` through
 * the border, needs no icon import, and runs as a CSS animation, so it keeps
 * turning smoothly while the main thread is busy with wasm and key derivation,
 * which is exactly when these screens are on display.
 */
export function Spinner({ className, label }: SpinnerProps) {
  const t = useAppT()
  return (
    <span role="status" className="inline-flex items-center">
      <span
        aria-hidden="true"
        className={cn(
          "size-5 animate-spin rounded-full border-2 border-current border-t-transparent",
          className
        )}
      />
      <span className="sr-only">{label ?? t("common.loading")}</span>
    </span>
  )
}

/** Centred in the viewport, for whole-page loads. */
export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div className="flex min-h-svh items-center justify-center text-muted-foreground">
      <Spinner className="size-6" label={label} />
    </div>
  )
}
