"use client"

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import sodium from "libsodium-wrappers-sumo"
import { generateSealKeyPair, sealBox } from "@krypta/crypto"

/**
 * Answers people actually need encryption for. Kept short so the sealed
 * output stays a readable block rather than a wall of base64.
 */
const SAMPLES = [
  "I reported the incident to HR in March.",
  "Diagnosed with type 1 diabetes in 2019.",
  "My manager asked me to sign the audit early.",
]

const TYPE_MS = 38
const HOLD_MS = 2800

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function getReducedMotion() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/** Server render has no media query to read; assume motion is allowed. */
function getReducedMotionServerSnapshot() {
  return false
}

/**
 * The whole animation as one value, so every transition happens in a single
 * async timer callback. Resetting `chars`/`sealed` at the same moment `index`
 * advances avoids a synchronous state reset in the effect body.
 */
interface Progress {
  index: number
  chars: number
  sealed: boolean
}

const INITIAL_PROGRESS: Progress = { index: 0, chars: 0, sealed: false }

/**
 * Runs the product's real sealing path in the visitor's browser: a genuine
 * hybrid ML-KEM-768 + X25519 keypair, a genuine KEM-DEM seal, and the actual
 * base64 that a response row would contain. Nothing here is mocked, which is
 * the point -- the landing page's central claim is demonstrated rather than
 * illustrated.
 *
 * The private key is generated locally and discarded; it never leaves this
 * component and is never sent anywhere.
 */
export function LiveSealDemo() {
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress>(INITIAL_PROGRESS)

  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    getReducedMotionServerSnapshot
  )

  // libsodium compiles its wasm asynchronously, so nothing can be sealed until
  // it resolves. This is a cold public page, so we cannot assume some earlier
  // screen already awaited it.
  useEffect(() => {
    let cancelled = false
    sodium.ready.then(() => {
      if (cancelled) return
      setPublicKey(generateSealKeyPair().publicKey)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const sample = SAMPLES[progress.index]

  // Under reduced motion the sample is shown already typed.
  const typed = reduced ? sample : sample.slice(0, progress.chars)

  /*
   * Sealing the typed PREFIX rather than the finished sample, so the
   * ciphertext is present from the first frame and visibly churns as the
   * sample is typed. It also removes a dead half-box: this demo sits in the
   * hero, and gating the output on a finished sample left the most valuable
   * panel on the page empty for the first two seconds.
   *
   * The output never changes height while it churns, because a fresh KEM
   * encapsulation is 1120 bytes whatever the message length, so the base64
   * fills the box even at zero typed characters.
   */
  const cipher = useMemo(
    () => (publicKey ? sealBox(typed, publicKey) : null),
    [typed, publicKey]
  )

  useEffect(() => {
    if (!publicKey || reduced) return

    let holdTimer: ReturnType<typeof setTimeout>

    const typeTimer = setInterval(() => {
      setProgress((current) => {
        if (current.chars < SAMPLES[current.index].length) {
          return { ...current, chars: current.chars + 1 }
        }

        clearInterval(typeTimer)
        holdTimer = setTimeout(() => {
          setProgress({
            index: (current.index + 1) % SAMPLES.length,
            chars: 0,
            sealed: false,
          })
        }, HOLD_MS)
        return { ...current, sealed: true }
      })
    }, TYPE_MS)

    return () => {
      clearInterval(typeTimer)
      clearTimeout(holdTimer)
    }
  }, [progress.index, publicKey, reduced])

  const showCaret = !reduced && !progress.sealed

  return (
    /*
     * No border, background or radius of its own: this sits inside a Bezel,
     * and a third rounded box nested in the other two cannot be concentric
     * with them. Its corner visibly crossed the enclosure's before this.
     */
    <figure
      className="p-6 sm:p-8"
      aria-label="A sample answer being encrypted in the browser, showing the ciphertext the server receives."
    >
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
          In the visitor&apos;s browser
        </span>
        <p
          aria-hidden="true"
          className="min-h-[3.5rem] text-base leading-relaxed sm:min-h-[3rem]"
        >
          {typed}
          {showCaret && (
            <span className="ml-0.5 inline-block h-[1.1em] w-[0.5ch] translate-y-[0.15em] animate-caret-blink bg-brand align-baseline" />
          )}
        </p>
      </div>

      <div className="my-5 border-t border-border" />

      <div className="flex flex-col gap-2">
        <span className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
          What our server stores
        </span>
        <p
          aria-hidden="true"
          /* Fixed (not min) height, so sealing never shifts the layout and a
             hybrid ML-KEM-768 + X25519 seal -- several times longer than the
             legacy X25519-only ciphertext -- scrolls inside the box instead
             of growing it. Narrow viewports wrap the base64 onto more lines,
             hence the larger height on small screens. */
          className="h-[7rem] overflow-y-auto font-mono text-[0.6875rem] leading-[1.7] break-all text-brand transition-opacity duration-500 ease-out sm:h-[6.5rem] sm:text-xs"
          style={{ opacity: cipher ? 1 : 0 }}
        >
          {cipher ?? ""}
        </p>
      </div>
    </figure>
  )
}
