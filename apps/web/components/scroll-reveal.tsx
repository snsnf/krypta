"use client"

import { useEffect } from "react"

/**
 * Reveals `.reveal-on-scroll` / `.reveal-stagger` elements as they enter the
 * viewport by flipping a `data-revealed` attribute; the actual motion is a CSS
 * transition.
 *
 * This replaced an `animation-timeline: view()` implementation, which is
 * Chrome-only and left every other browser with no animation at all.
 * IntersectionObserver is universally supported and costs no scroll listener.
 *
 * The hidden start state is gated on `@media (scripting: enabled)` in CSS, so
 * if this never runs the content is simply visible rather than stuck at
 * opacity 0.
 */
export function ScrollReveal() {
  useEffect(() => {
    const targets = document.querySelectorAll<HTMLElement>(
      ".reveal-on-scroll, .reveal-stagger"
    )
    if (targets.length === 0) return

    const reveal = (el: Element) => el.setAttribute("data-revealed", "")

    // Matches the CSS gate: under reduced motion nothing is hidden to begin
    // with, so just mark everything revealed and skip observing.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      targets.forEach(reveal)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          reveal(entry.target)
          // Reveal once. Re-animating on every scroll past is noise.
          observer.unobserve(entry.target)
        }
      },
      { threshold: 0, rootMargin: "0px 0px -12% 0px" }
    )

    targets.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return null
}
