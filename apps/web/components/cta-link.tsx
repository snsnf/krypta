import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"

interface CtaLinkProps {
  href: string
  children: React.ReactNode
  variant?: "primary" | "glass"
  className?: string
}

/**
 * The page's primary call to action. The trailing arrow sits in its own circle
 * flush inside the pill rather than floating next to the label, and the two
 * move against each other on hover: the pill compresses while the circle
 * travels out and up, so the control reads as a mechanism rather than a
 * rectangle that changes colour.
 *
 * Colours come from the existing primary/border tokens, so both variants keep
 * the contrast the design system already verified in each theme.
 */
export function CtaLink({
  href,
  children,
  variant = "primary",
  className,
}: CtaLinkProps) {
  const glass = variant === "glass"

  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-3 rounded-full py-2 pr-2 pl-6 text-base font-medium",
        "transition-transform duration-500 ease-out will-change-transform active:scale-[0.97]",
        glass
          ? "border border-black/10 bg-black/[0.04] text-foreground backdrop-blur-md hover:bg-black/[0.07] dark:border-white/15 dark:bg-white/[0.06] dark:hover:bg-white/[0.10]"
          : "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]",
        className
      )}
    >
      {children}
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          "transition-transform duration-500 ease-out",
          "group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:scale-105",
          glass
            ? "bg-black/[0.06] dark:bg-white/10"
            : "bg-primary-foreground/15"
        )}
      >
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={18} strokeWidth={1.8} />
      </span>
    </Link>
  )
}
