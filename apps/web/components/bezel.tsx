import { cn } from "@/lib/utils"

interface BezelProps {
  children: React.ReactNode
  /** Lifts the inner core with the brand tint, for the one card per group that leads. */
  tinted?: boolean
  /**
   * Outer radius, as any CSS length. The inner core derives from it, so the
   * two curves stay concentric whatever this is set to.
   */
  radius?: string
  /**
   * `page` draws the enclosure as alpha over a known page background, which is
   * what the landing page sits on.
   *
   * `token` draws it from muted/card/border instead. A themed form surface
   * owns those tokens and encodes its own light or dark mode in them, so it
   * must not receive `dark:` utility variants: those key off the dashboard's
   * ancestor `.dark` class and would fire inside a light-mode form embedded in
   * a dark dashboard. globals.css fights that same leak for inputs and
   * buttons; this avoids it rather than having to override it.
   */
  surface?: "page" | "token"
  className?: string
  innerClassName?: string
}

/**
 * A container built as two nested enclosures rather than one bordered box: an
 * outer tray with its own hairline, and an inner core inset from it by the
 * tray's padding.
 *
 * The radii are related through `--bezel-radius` rather than written out
 * twice, so the inner curve cannot drift from the outer one. That drift is not
 * hypothetical: it shipped once, as a third rounded box nested inside these
 * two with a radius that owed nothing to either, and the crossing corners were
 * visible on the hero.
 */
export function Bezel({
  children,
  tinted = false,
  radius = "2rem",
  surface = "page",
  className,
  innerClassName,
}: BezelProps) {
  const token = surface === "token"

  return (
    <div
      style={{ "--bezel-radius": radius } as React.CSSProperties}
      className={cn(
        "rounded-[var(--bezel-radius)] p-1.5",
        token
          ? "border border-border bg-muted"
          : "border border-black/[0.06] bg-black/[0.02] dark:border-white/[0.08] dark:bg-white/[0.03]",
        className
      )}
    >
      <div
        className={cn(
          // The tray's padding is the whole difference between the two radii.
          "h-full rounded-[calc(var(--bezel-radius)-0.375rem)] border",
          token
            ? "border-border bg-card"
            : "border-black/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-white/[0.06] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
          !token &&
            (tinted
              ? "bg-brand/[0.12] dark:bg-brand/[0.10]"
              : "bg-white/70 backdrop-blur-sm dark:bg-white/[0.02]"),
          innerClassName
        )}
      >
        {children}
      </div>
    </div>
  )
}
