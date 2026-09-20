import type { Metadata } from "next"
import Link from "next/link"
import { CipherReveal } from "@/components/cipher-reveal"
import { CtaLink } from "@/components/cta-link"
import { KryptaLogo } from "@/components/krypta-logo"
import { PixelBlastBackdrop } from "@/components/pixel-blast-backdrop"

// Next already marks a not-found response noindex; only the title is ours.
export const metadata: Metadata = {
  title: "Page not found",
}

/**
 * Looks like an unreadable record on purpose: the product's whole idea is that
 * some bytes cannot be opened, and a missing page is the one case where that
 * is the visitor's problem rather than the promise.
 */
const CIPHERTEXT =
  "K2 8f1c 03ab e77d 5a90 c4e2 1b6f d8a3 72e9 4c0b f53d 91a7 6e28 b0c5 3d7f"

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-5">
        <Link
          href="/"
          aria-label="krypta home"
          className="flex items-center gap-2 rounded-full border border-black/[0.08] bg-white/70 px-4 py-2 font-heading text-base font-semibold tracking-tight shadow-[0_8px_32px_-12px_rgba(0,0,0,0.18)] backdrop-blur-xl dark:border-white/[0.10] dark:bg-black/50 dark:shadow-[0_8px_32px_-12px_rgba(0,0,0,0.7)]"
        >
          <KryptaLogo className="h-5 w-auto text-brand" />
          krypta
        </Link>
      </header>

      <main className="relative flex flex-1 items-center overflow-hidden px-6 pt-32 pb-20">
        <PixelBlastBackdrop />
        <div className="relative z-10 mx-auto w-full max-w-3xl">
          <span className="inline-flex items-center rounded-full border border-black/[0.08] bg-black/[0.03] px-3 py-1 font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase dark:border-white/[0.12] dark:bg-white/[0.04]">
            Error 404
          </span>
          <h1 className="mt-6 font-heading text-[clamp(2.75rem,7vw,5rem)] leading-[0.95] font-semibold tracking-[-0.045em] text-balance">
            <CipherReveal text="Nothing here to unseal." />
          </h1>
          <p className="mt-7 max-w-lg text-lg leading-relaxed text-muted-foreground">
            This page does not exist, or its link was copied incompletely. A
            form link carries its key after the hash sign, and stops working
            when that part is cut off, so check the whole address made it
            across.
          </p>
          <p
            aria-hidden="true"
            className="mt-10 max-w-lg font-mono text-xs leading-loose tracking-[0.18em] text-muted-foreground/40 select-none"
          >
            {CIPHERTEXT}
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <CtaLink href="/">Back to the start</CtaLink>
            <CtaLink href="/dashboard" variant="glass">
              Open my dashboard
            </CtaLink>
          </div>
        </div>
      </main>
    </div>
  )
}
