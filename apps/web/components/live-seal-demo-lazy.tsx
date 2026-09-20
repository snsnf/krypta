"use client"

import dynamic from "next/dynamic"

// The demo pulls in the hybrid ML-KEM-768 + X25519 sealing library (via
// @krypta/crypto) just to show real ciphertext. That library is required
// eagerly on the public form page, which has no choice but to seal. But the
// landing page only needs it once this demo is visible, so it's loaded on
// demand instead of adding it to the initial bundle every visitor downloads.
//
// `next/dynamic`'s `ssr: false` only works inside a Client Component, hence
// this thin wrapper around the server-rendered landing page.
//
// The demo sits in the hero, inside the initial viewport (not behind a
// scroll reveal), so a placeholder whose height doesn't match causes a
// visible jump on every load. Rather than hardcoding a fixed pixel guess,
// this placeholder mirrors the real component's outer box (padding, label
// rows, divider) and its two content-box heights class-for-class from
// live-seal-demo.tsx, so it tracks the real component's responsive height
// at every breakpoint instead of only approximating one of them.
function LiveSealDemoPlaceholder() {
  return (
    <div
      aria-hidden
      className="p-6 sm:p-8"
    >
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
          In the visitor&apos;s browser
        </span>
        <div className="min-h-[3.5rem] sm:min-h-[3rem]" />
      </div>

      <div className="my-5 border-t border-border" />

      <div className="flex flex-col gap-2">
        <span className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
          What our server stores
        </span>
        <div className="h-[7rem] sm:h-[6.5rem]" />
      </div>
    </div>
  )
}

export const LiveSealDemo = dynamic(
  () => import("@/components/live-seal-demo").then((mod) => mod.LiveSealDemo),
  { ssr: false, loading: () => <LiveSealDemoPlaceholder /> }
)
