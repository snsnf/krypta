"use client"

import { Fragment, useEffect, useState } from "react"

const SCRAMBLE_CHARS = "!<>-_\\/[]{}~=+*^?#$%&0123456789"
const STEP_MS = 22
const LOCK_STAGGER_STEPS = 1
const LOCK_AFTER_STEPS = 4

interface CipherRevealProps {
  text: string
  className?: string
}

/** Word plus its offset in `text`, so each glyph can find its scrambled twin. */
function splitWords(text: string) {
  const words: { word: string; start: number }[] = []
  let start = 0
  for (const word of text.split(" ")) {
    words.push({ word, start })
    start += word.length + 1
  }
  return words
}

/**
 * Resolves scrambled ciphertext-like noise into the real text, left to right,
 * once on mount. This is the product's signature moment, decryption as a
 * page-load animation, so it appears only on the landing hero and not on
 * frequently-viewed screens.
 *
 * Layout is pinned to the final text rather than the scrambled text: every
 * glyph renders in a cell sized by the character it will become, and words are
 * unbreakable so lines can only break at real spaces. Without that the wide
 * scramble glyphs (#, %, <) reflow the headline onto an extra line mid
 * animation and it snaps back when the real text lands.
 */
export function CipherReveal({ text, className }: CipherRevealProps) {
  const [display, setDisplay] = useState(text)

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    // `display` is already initialized to `text`, so reduced motion needs no
    // state update. Just skip the scramble entirely.
    if (prefersReducedMotion) {
      return
    }

    const totalSteps = text.length * LOCK_STAGGER_STEPS + 10
    let step = 0
    let lastStepTime = 0
    let rafId: number

    // requestAnimationFrame paced to STEP_MS via a timestamp accumulator, rather
    // than setTimeout, keeps this display-synced and avoids driving React
    // updates from a timer that free-runs independently of the paint cycle.
    function tick(now: number) {
      if (now - lastStepTime < STEP_MS) {
        rafId = requestAnimationFrame(tick)
        return
      }
      lastStepTime = now

      const next = text
        .split("")
        .map((char, i) => {
          if (char === " ") return " "
          const lockStep = i * LOCK_STAGGER_STEPS
          if (step >= lockStep + LOCK_AFTER_STEPS) return char
          return SCRAMBLE_CHARS[
            Math.floor(Math.random() * SCRAMBLE_CHARS.length)
          ]
        })
        .join("")
      setDisplay(next)
      step += 1
      if (step <= totalSteps) {
        rafId = requestAnimationFrame(tick)
      } else {
        setDisplay(text)
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [text])

  // Once resolved, drop the per-character scaffolding entirely and render plain
  // text. That covers the server render, reduced motion, and everything after
  // the animation, so the duplicated glyphs never reach text selection and the
  // heading gets its accessible name the ordinary way.
  if (display === text) {
    return <span className={className}>{text}</span>
  }

  return (
    <span className={className}>
      {/* The visual layer is hidden from assistive tech, so the real text has
          to be exposed separately or the heading has no accessible name. */}
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {splitWords(text).map(({ word, start }, wordIndex) => (
          <Fragment key={`${word}-${start}`}>
            {wordIndex > 0 && " "}
            <span className="whitespace-nowrap">
              {word.split("").map((char, charIndex) => (
                <span key={charIndex} className="relative inline-block">
                  {/* Sizes the cell to the final glyph and never changes. */}
                  <span className="invisible">{char}</span>
                  {/*
                    Absolute so a wide scramble glyph cannot widen the cell.
                    Stacking these in one grid cell does not work: the track
                    sizes to the larger of the two, so the shift comes back.
                    Centred, so any overhang splits evenly either side.
                  */}
                  <span className="absolute top-0 left-1/2 -translate-x-1/2">
                    {display[start + charIndex] ?? char}
                  </span>
                </span>
              ))}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  )
}
