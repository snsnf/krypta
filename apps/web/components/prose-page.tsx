import Link from "next/link"
import type { ReactNode } from "react"
import { LanguageMenu } from "@/components/language-switcher"

/**
 * The chrome the three text pages share: /security, /privacy and /terms.
 *
 * It exists because there were about to be three copies of the same header,
 * measure and type scale, and the first edit to one of them would have left
 * the other two behind. It carries layout only. What each page says, and how
 * far it is allowed to go, is the page's own business.
 */
export function ProsePage({
  title,
  updated,
  updatedLabel = "Last updated",
  children,
}: {
  title: string
  /** "Last updated", in the page's language. */
  updatedLabel?: string
  /**
   * When the text last changed, in prose.
   *
   * A date a reader can check is what makes a policy worth reading: without
   * one they cannot tell whether it describes the service they signed up to.
   * It is written by hand rather than taken from the clock, for the same
   * reason the sitemap's is: a date that moves on its own says nothing.
   */
  updated?: string
  children: ReactNode
}) {
  return (
    <div className="min-h-svh">
      <header className="px-6 pt-10">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <Link
            href="/"
            className="font-heading text-lg font-semibold tracking-[-0.02em] transition-opacity duration-150 ease-out hover:opacity-70"
          >
            krypta
          </Link>
          <LanguageMenu />
        </div>
      </header>

      <main className="px-6 py-16 sm:py-24">
        <div className="mx-auto max-w-3xl">
          <h1 className="font-heading text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.02] font-semibold tracking-[-0.02em]">
            {title}
          </h1>
          {updated && (
            <p className="mt-5 font-mono text-xs tracking-wide text-muted-foreground">
              {updatedLabel} {updated}
            </p>
          )}
          {children}
        </div>
      </main>
    </div>
  )
}

export function ProseLead({ children }: { children: ReactNode }) {
  return (
    <p className="mt-8 text-lg leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/** A body paragraph, spaced to follow either a heading or another paragraph. */
export function ProseText({ children }: { children: ReactNode }) {
  return (
    <p className="mt-5 leading-relaxed text-muted-foreground">{children}</p>
  )
}

export function ProseSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="mt-16">
      <h2 className="font-heading text-2xl font-semibold tracking-[-0.02em]">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * A list where each entry is a claim in its own right, divided rather than
 * bulleted so a long entry does not read as a fragment.
 */
export function ProseList({ items }: { items: string[] }) {
  return (
    <ul className="mt-6 flex flex-col divide-y divide-black/[0.06] dark:divide-white/[0.07]">
      {items.map((item) => (
        <li
          key={item}
          className="py-4 leading-relaxed text-muted-foreground first:pt-0 last:pb-0"
        >
          {item}
        </li>
      ))}
    </ul>
  )
}
