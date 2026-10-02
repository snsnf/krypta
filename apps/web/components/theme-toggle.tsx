"use client"

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { useTheme } from "next-themes"
import { HugeiconsIcon } from "@hugeicons/react"
import { ComputerIcon, Moon02Icon, Sun02Icon } from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { useAppT, type AppTranslator } from "@/lib/app-i18n"

export type ColorModeChoice = "light" | "system" | "dark"

const OPTIONS = [
  { value: "light", icon: Sun02Icon },
  { value: "system", icon: ComputerIcon },
  { value: "dark", icon: Moon02Icon },
] as const

const OPTION_SIZE = 28
// Mirrors --ease-in-out, the curve the theme reveal in globals.css uses, since
// the two play together. --ease-out is wrong at this distance: it is a quint
// curve, so over one 28px hop it spends 60% of the travel in the first two
// frames and the slide reads as a jump with no animation at all.
const SLIDE_EASE = "cubic-bezier(0.77, 0, 0.175, 1)"
const SLIDE_MS = 300

// The pill's resting position is an inline transform, so the slide has to
// start in the same commit that moves it or the browser paints one frame with
// the pill already at its destination. React logs a warning for
// useLayoutEffect during a server render, and this component's hooks do run
// there, so fall back where there is no DOM.
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect

function noopSubscribe() {
  return () => {}
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * Applies a colour change behind the circular reveal from the point that was
 * clicked, the view transition globals.css styles. Falls back to an instant
 * change where view transitions are missing or motion is reduced.
 */
export function revealColorChange(x: number, y: number, apply: () => void) {
  const supportsViewTransition =
    "startViewTransition" in document &&
    typeof document.startViewTransition === "function"

  if (!supportsViewTransition || prefersReducedMotion()) {
    apply()
    return
  }

  document.documentElement.style.setProperty("--theme-toggle-x", `${x}px`)
  document.documentElement.style.setProperty("--theme-toggle-y", `${y}px`)
  document.startViewTransition(() => {
    flushSync(apply)
  })
}

interface ColorModeSwitchProps {
  value: ColorModeChoice
  /** Called with the choice and the centre of the button that made it. */
  onChange: (value: ColorModeChoice, x: number, y: number) => void
  label: string
  optionLabels: Record<ColorModeChoice, string>
  className?: string
  pillClassName?: string
}

/**
 * Three icons with a pill that slides to the chosen one. Presentational: the
 * site theme and a public form's own colour mode each own their state and
 * hand it in, so both read and move the same way.
 */
export function ColorModeSwitch({
  value,
  onChange,
  label,
  optionLabels,
  className,
  pillClassName,
}: ColorModeSwitchProps) {
  const activeIndex = Math.max(
    OPTIONS.findIndex((option) => option.value === value),
    0
  )

  const pillRef = useRef<HTMLDivElement>(null)
  const previousIndexRef = useRef<number | null>(null)
  const slideRef = useRef<Animation | null>(null)

  useBrowserLayoutEffect(() => {
    const pill = pillRef.current
    const previousIndex = previousIndexRef.current
    previousIndexRef.current = activeIndex
    if (!pill || previousIndex === null || previousIndex === activeIndex) {
      return
    }

    // next-themes' disableTransitionOnChange briefly forces `transition: none`
    // on every element while the theme class swaps, which would otherwise
    // swallow this slide entirely. The Web Animations API runs independently
    // of the CSS `transition` property, so it survives that window.
    //
    // Each run fills forwards, so the one before it has to be cancelled or a
    // fast clicker stacks a filled animation per click on the same element.
    slideRef.current?.cancel()
    slideRef.current = pill.animate(
      [
        { transform: `translateX(${previousIndex * OPTION_SIZE}px)` },
        { transform: `translateX(${activeIndex * OPTION_SIZE}px)` },
      ],
      {
        duration: prefersReducedMotion() ? 0 : SLIDE_MS,
        easing: SLIDE_EASE,
        fill: "forwards",
      }
    )
  }, [activeIndex])

  return (
    <div
      role="radiogroup"
      aria-label={label}
      // Sun, monitor and moon have no reading order, and the pill is
      // positioned from the left; inside a right-to-left form the row would
      // reverse and leave the pill under the wrong icon.
      dir="ltr"
      className={cn(
        "relative flex shrink-0 items-center gap-0 rounded-full border border-border bg-muted/50 p-0.5",
        className
      )}
    >
      <div
        ref={pillRef}
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0.5 left-0.5 size-7 rounded-full bg-background shadow-sm",
          pillClassName
        )}
        style={{ transform: `translateX(${activeIndex * OPTION_SIZE}px)` }}
      />
      {OPTIONS.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={optionLabels[option.value]}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              onChange(
                option.value,
                rect.left + rect.width / 2,
                rect.top + rect.height / 2
              )
            }}
            className={cn(
              "relative z-10 flex size-7 items-center justify-center rounded-full transition-[color,transform] duration-150 ease-out focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.97] motion-reduce:active:scale-100",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <HugeiconsIcon icon={option.icon} size={15} />
          </button>
        )
      })}
    </div>
  )
}

/** A form's own colour mode, in the builder and on the public form. */
export const FORM_COLOR_MODE_LABELS: Record<ColorModeChoice, string> = {
  light: "Light",
  system: "System",
  dark: "Dark",
}

/** The site theme control's accessible names, in the app's language. */
export function siteThemeLabels(t: AppTranslator): {
  label: string
  optionLabels: Record<ColorModeChoice, string>
} {
  return {
    label: t("header.theme"),
    optionLabels: {
      light: t("header.lightTheme"),
      system: t("header.systemTheme"),
      dark: t("header.darkTheme"),
    },
  }
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const { label, optionLabels } = siteThemeLabels(useAppT())
  // The resolved theme is unknown until next-themes hydrates from
  // localStorage. useSyncExternalStore reports `false` for the server render
  // and the first client render, then lets React reconcile to `true` once
  // hydration is done, without a manual effect + setState render pass.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )

  if (!mounted) {
    return (
      <div
        aria-hidden="true"
        className="h-[30px] w-[86px] shrink-0 rounded-full border border-transparent"
      />
    )
  }

  const active: ColorModeChoice =
    theme === "light" || theme === "dark" ? theme : "system"

  return (
    <ColorModeSwitch
      value={active}
      label={label}
      optionLabels={optionLabels}
      onChange={(value, x, y) => revealColorChange(x, y, () => setTheme(value))}
    />
  )
}
