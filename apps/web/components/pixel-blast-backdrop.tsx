"use client"

import dynamic from "next/dynamic"
import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"

/*
 * PixelBlast pulls in three and postprocessing, which together are by far the
 * heaviest thing this route loads. It is deliberately kept off the critical
 * path: no SSR, no import until the hero has already rendered, and no mount at
 * all for a visitor who has asked for less motion. The headline stays the LCP
 * element either way.
 */
const PixelBlast = dynamic(() => import("@/components/PixelBlast"), {
  ssr: false,
  loading: () => null,
})

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function getReducedMotion() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/** No media query to read on the server; the effect never renders there anyway. */
function getReducedMotionServerSnapshot() {
  return true
}

/**
 * The animated field behind the hero. It carries no information, so it is
 * hidden from assistive technology and is safe to drop entirely: every state
 * below returns null and the hero simply renders on its own background.
 */
export function PixelBlastBackdrop() {
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    getReducedMotionServerSnapshot
  )
  const { resolvedTheme } = useTheme()

  // Honouring the OS setting matters more here than anywhere else on the page:
  // this is a full-bleed field of moving pixels directly behind body copy.
  if (reduced || !resolvedTheme) return null

  // The two brand greens from globals.css. The dark one is unreadable as a
  // field on a near-black ground, and the light one washes out on white.
  const color = resolvedTheme === "dark" ? "#85ca98" : "#356343"

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden [mask-image:radial-gradient(115%_95%_at_50%_42%,black_38%,transparent_84%)]"
    >
      <PixelBlast
        variant="square"
        color={color}
        pixelSize={4}
        patternScale={2.4}
        patternDensity={0.9}
        pixelSizeJitter={0.4}
        speed={0.32}
        edgeFade={0.7}
        enableRipples={false}
        transparent
        className="h-full w-full opacity-[0.5] dark:opacity-[0.55]"
      />
    </div>
  )
}
