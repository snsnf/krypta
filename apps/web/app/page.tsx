import type { Metadata } from "next"
import { headers } from "next/headers"
import Link from "next/link"
import { legalIdentity } from "@/lib/legal"
import { appTranslator, translateKey } from "@/lib/app-translator"
import { getAppLanguage } from "@/lib/app-locale-server"
import { LanguageMenu } from "@/components/language-switcher"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Attachment01Icon,
  Edit02Icon,
  Key01Icon,
  Link01Icon,
  ListViewIcon,
  ServerStack01Icon,
  TaskEdit01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"
import { Bezel } from "@/components/bezel"
import { Button } from "@/components/ui/button"
import { CipherReveal } from "@/components/cipher-reveal"
import { CtaLink } from "@/components/cta-link"
import { KryptaLogo } from "@/components/krypta-logo"
import { LiveSealDemo } from "@/components/live-seal-demo-lazy"
import { PixelBlastBackdrop } from "@/components/pixel-blast-backdrop"
import { FaqAccordion } from "@/components/faq-accordion"
import { ScrollReveal } from "@/components/scroll-reveal"
import { ThemeToggle } from "@/components/theme-toggle"

const STEPS = [
  { key: "build", icon: TaskEdit01Icon },
  { key: "share", icon: Link01Icon },
  { key: "decrypt", icon: Key01Icon },
] as const

/*
 * Every claim below is checked against shipped behaviour. Spans are chosen so
 * the two rows fill exactly (7+5, then 4+4+4) with no empty cell.
 */
const FEATURES = [
  { key: "types", icon: ListViewIcon, span: "lg:col-span-7", tinted: true },
  {
    key: "files",
    icon: Attachment01Icon,
    span: "lg:col-span-5",
    tinted: false,
  },
  { key: "edit", icon: Edit02Icon, span: "lg:col-span-4", tinted: false },
  {
    key: "noAccount",
    icon: UserGroupIcon,
    span: "lg:col-span-4",
    tinted: true,
  },
  {
    key: "self",
    icon: ServerStack01Icon,
    span: "lg:col-span-4",
    tinted: false,
    // Real, and the one feature whose proof fits on a single line.
    command: "docker compose up -d",
  },
] as const

/*
 * Plan limits mirror migration 0022 exactly: free is 10 open forms, 200 MB,
 * and 250 responses a month; pro is 5 GB with ceilings high enough to be
 * fair-use bounds rather than product limits, so they are described as such
 * rather than printed as numbers a buyer would plan against.
 *
 * No per-card button: both plans begin with the same signup, so the page keeps
 * one label for that intent and the CTA section below carries it.
 */
const PLANS = [
  { key: "free", featured: false, items: ["forms", "files", "responses"] },
  { key: "pro", featured: true, items: ["unlimited", "files", "free"] },
] as const

/*
 * Answers verified against the code, not written to sound reassuring. Recovery
 * exists now (apps/api/src/auth/recovery_routes.rs) but needs the recovery
 * code, so the first answer is conditional rather than absolute, and stays
 * absolute for the case where that code is gone, because it is.
 *
 * The quantum answer describes packages/crypto/src/seal.ts and nothing more:
 * what is sealed under the hybrid KEM, and that the symmetric layer is
 * unchanged because it never needed changing. It deliberately claims no
 * absolute: "quantum-proof" and "future-proof" would both be false, not
 * least because the JavaScript ML-KEM implementation is not independently
 * audited. That caveat lives in CLAUDE.md, not here; nothing on this page may
 * contradict it.
 */
const FAQS = ["forgot", "handover", "quantum", "email", "edit"] as const

/*
 * These two lists are load-bearing security claims, not marketing copy. The
 * password and the recovery code now belong in the second list: the browser
 * derives a key from each and sends only a one-way verifier
 * (packages/crypto/src/account-key.ts), so neither reaches us.
 *
 * The limits that claim does not cover, and that nothing here may contradict:
 * an attacker holding the database can still guess a weak password offline,
 * and an operator serving modified JavaScript could take keys from the page.
 * That second one is true of every browser-delivered encryption scheme.
 */
const STORED = ["cipher", "ids", "keys"] as const

const NEVER_SEEN = ["content", "secrets", "key", "files"] as const

export async function generateMetadata(): Promise<Metadata> {
  const t = appTranslator(await getAppLanguage())
  return {
    // The one route meant for search results. Canonical so the www, trailing
    // slash and query-string variants all resolve to it.
    alternates: { canonical: "/" },
    description: t("meta.description"),
  }
}

/**
 * Structured data for the one page that ranks. Plain facts only: nothing here
 * may promise more than the copy on the page does.
 */
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "krypta",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description:
    "Encrypted forms. Every response is sealed in the visitor's browser, so we store ciphertext and only you hold the key.",
  // Both plans, because the pricing section below shows both. One offer at
  // zero would have search results advertise a free product and nothing else.
  offers: [
    { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
    { "@type": "Offer", name: "Pro", price: "12", priceCurrency: "USD" },
  ],
}

export default async function LandingPage() {
  const t = appTranslator(await getAppLanguage())
  const tk = (key: string) => translateKey(t, key)
  // Inline JSON-LD is a script as far as the CSP is concerned, so it carries
  // the same per-request nonce proxy.ts minted for everything else.
  const nonce = (await headers()).get("x-nonce") ?? undefined
  // Read per request, like the nonce above: the operator's details are runtime
  // configuration, so a prerendered footer would carry the build machine's.
  const legal = legalIdentity()
  return (
    <div className="flex min-h-svh flex-col" data-smooth-scroll>
      <script
        type="application/ld+json"
        nonce={nonce}
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
      <ScrollReveal />

      {/*
       * A detached glass pill rather than a full-width bar glued to the top.
       * Fixed, so the backdrop filter runs on one small composited layer and
       * never on scrolling content. Only two secondary links exist, so they
       * drop below sm instead of collapsing into a menu: a hamburger guarding
       * two destinations costs a tap and buys nothing.
       */}
      <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-5">
        <nav className="flex w-max items-center gap-1 rounded-full border border-black/[0.08] bg-white/70 p-1.5 ps-5 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.18)] backdrop-blur-xl sm:gap-2 dark:border-white/[0.10] dark:bg-black/50 dark:shadow-[0_8px_32px_-12px_rgba(0,0,0,0.7)]">
          <Link
            href="/"
            className="flex items-center gap-2 pe-2 font-heading text-base font-semibold tracking-tight"
          >
            <KryptaLogo className="h-6 w-auto text-brand" />
            krypta
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="hidden rounded-full sm:inline-flex"
            nativeButton={false}
            render={<Link href="#how-it-works" />}
          >
            {t("landing.nav.how")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="hidden rounded-full sm:inline-flex"
            nativeButton={false}
            render={<Link href="#pricing" />}
          >
            {t("landing.nav.pricing")}
          </Button>
          <LanguageMenu />
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            nativeButton={false}
            render={<Link href="/login" />}
          >
            {t("landing.nav.login")}
          </Button>
        </nav>
      </header>

      <main className="flex-1">
        {/*
         * Editorial split: the claim owns the left half at display scale, the
         * running proof owns the right. The animated field sits behind both and
         * is masked out before it reaches the copy.
         */}
        <section className="relative flex min-h-[100dvh] items-center overflow-hidden px-6 pt-32 pb-20">
          <PixelBlastBackdrop />
          <div className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-14 lg:grid-cols-12 lg:gap-16">
            <div className="lg:col-span-6">
              <span className="inline-flex items-center rounded-full border border-black/[0.08] bg-black/[0.03] px-3 py-1 font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase dark:border-white/[0.12] dark:bg-white/[0.04]">
                {t("landing.hero.badge")}
              </span>
              <h1 className="mt-6 font-heading text-[clamp(3rem,8vw,5.5rem)] leading-[0.92] font-semibold tracking-[-0.03em] text-balance">
                <CipherReveal text={t("landing.hero.title")} />
              </h1>
              <p className="mt-7 max-w-md text-lg leading-relaxed text-muted-foreground">
                {t("landing.hero.body")}
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-3">
                <CtaLink href="/signup">{t("landing.hero.create")}</CtaLink>
                <CtaLink href="#how-it-works" variant="glass">
                  {t("landing.nav.how")}
                </CtaLink>
              </div>
            </div>

            <div className="lg:col-span-6">
              <Bezel className="shadow-[0_24px_60px_-28px_rgba(53,99,67,0.45)] dark:shadow-[0_24px_60px_-28px_rgba(0,0,0,0.75)]">
                <LiveSealDemo />
              </Bezel>
            </div>
          </div>
        </section>

        {/*
         * The proof sits directly under the hero: it is the one claim a
         * sceptical reader arrives wanting to check.
         */}
        <section className="px-6 py-28 lg:py-36">
          <div className="mx-auto max-w-6xl">
            <span className="reveal-on-scroll inline-flex items-center rounded-full border border-black/[0.08] bg-black/[0.03] px-3 py-1 font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase dark:border-white/[0.12] dark:bg-white/[0.04]">
              {t("landing.boundary.badge")}
            </span>
            <h2 className="reveal-on-scroll mt-6 max-w-2xl font-heading text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.02] font-semibold tracking-[-0.02em]">
              {t("landing.boundary.title")}
            </h2>
            <div className="mt-14 grid gap-5 sm:grid-cols-2">
              <Bezel tinted className="reveal-stagger">
                <div className="p-8 sm:p-10">
                  <h3 className="font-mono text-[10px] tracking-[0.2em] text-brand uppercase">
                    {t("landing.boundary.stored")}
                  </h3>
                  <ul className="mt-7 flex flex-col divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                    {STORED.map((item) => (
                      <li
                        key={item}
                        className="py-4 text-lg leading-snug tracking-[-0.01em] first:pt-0 last:pb-0"
                      >
                        {tk(`landing.boundary.storedItems.${item}`)}
                      </li>
                    ))}
                  </ul>
                </div>
              </Bezel>
              <Bezel className="reveal-stagger">
                <div className="p-8 sm:p-10">
                  <h3 className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">
                    {t("landing.boundary.never")}
                  </h3>
                  <ul className="mt-7 flex flex-col divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                    {NEVER_SEEN.map((item) => (
                      <li
                        key={item}
                        className="py-4 text-lg leading-snug tracking-[-0.01em] text-muted-foreground first:pt-0 last:pb-0"
                      >
                        {tk(`landing.boundary.neverItems.${item}`)}
                      </li>
                    ))}
                  </ul>
                </div>
              </Bezel>
            </div>
          </div>
        </section>

        <section className="px-6 pb-28 lg:pb-36">
          <div className="mx-auto max-w-6xl">
            <h2 className="reveal-on-scroll max-w-2xl font-heading text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.02] font-semibold tracking-[-0.02em]">
              {t("landing.features.title")}{" "}
              <span className="text-brand">{t("landing.features.accent")}</span>
            </h2>
            {/* Asymmetric on purpose: 7+5 then 4+4+4 fills both rows exactly. */}
            <div className="mt-14 grid gap-5 lg:grid-cols-12">
              {FEATURES.map((feature) => (
                <Bezel
                  key={feature.key}
                  tinted={feature.tinted}
                  className={`reveal-stagger ${feature.span}`}
                >
                  <div className="flex h-full flex-col gap-3 p-8">
                    <HugeiconsIcon
                      icon={feature.icon}
                      size={24}
                      strokeWidth={1.5}
                      className="mb-2 text-brand"
                    />
                    <h3 className="font-heading text-xl font-semibold tracking-[-0.02em]">
                      {tk(`landing.features.${feature.key}.title`)}
                    </h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {tk(`landing.features.${feature.key}.body`)}
                    </p>
                    {"command" in feature && (
                      <code
                        dir="ltr"
                        className="mt-auto rounded-xl border border-black/[0.07] bg-black/[0.03] px-3.5 py-2.5 font-mono text-xs break-all text-brand dark:border-white/[0.08] dark:bg-white/[0.03]"
                      >
                        {feature.command}
                      </code>
                    )}
                  </div>
                </Bezel>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-28 px-6 pb-28 lg:pb-36">
          <div className="mx-auto grid max-w-6xl gap-14 lg:grid-cols-12 lg:gap-16">
            <div className="lg:col-span-5">
              <span className="reveal-on-scroll inline-flex items-center rounded-full border border-black/[0.08] bg-black/[0.03] px-3 py-1 font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase dark:border-white/[0.12] dark:bg-white/[0.04]">
                {t("landing.nav.how")}
              </span>
              <h2 className="reveal-on-scroll mt-6 font-heading text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.02] font-semibold tracking-[-0.02em] text-balance">
                {t("landing.steps.title")}
              </h2>
            </div>
            {/*
             * A connected sequence rather than parallel columns: the rule runs
             * between the markers because these steps genuinely happen in order.
             */}
            <ol className="lg:col-span-7">
              {STEPS.map((step, index) => (
                <li
                  key={step.key}
                  className="reveal-stagger relative flex gap-6 pb-10 last:pb-0"
                >
                  {index < STEPS.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="absolute start-[1.625rem] top-14 bottom-0 w-px bg-gradient-to-b from-black/[0.12] to-transparent dark:from-white/[0.14]"
                    />
                  )}
                  <span className="flex size-13 shrink-0 items-center justify-center rounded-full border border-black/[0.07] bg-brand/[0.12] text-brand shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-white/[0.08] dark:bg-brand/[0.10] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
                    <HugeiconsIcon
                      icon={step.icon}
                      size={22}
                      strokeWidth={1.5}
                    />
                  </span>
                  <div className="flex flex-col gap-2 pt-2.5">
                    <span className="font-heading text-xl font-semibold tracking-[-0.02em]">
                      {tk(`landing.steps.${step.key}.title`)}
                    </span>
                    <span className="text-sm leading-relaxed text-muted-foreground">
                      {tk(`landing.steps.${step.key}.body`)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="pricing" className="scroll-mt-28 px-6 pb-28 lg:pb-36">
          <div className="mx-auto max-w-6xl">
            <h2 className="reveal-on-scroll max-w-2xl font-heading text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.02] font-semibold tracking-[-0.02em]">
              {t("landing.pricing.title")}
            </h2>
            <div className="mt-14 grid gap-5 sm:grid-cols-2">
              {PLANS.map((plan) => (
                <Bezel
                  key={plan.key}
                  tinted={plan.featured}
                  className="reveal-stagger"
                >
                  <div className="flex h-full flex-col p-8 sm:p-10">
                    <h3
                      className={`font-mono text-[10px] tracking-[0.2em] uppercase ${
                        plan.featured ? "text-brand" : "text-muted-foreground"
                      }`}
                    >
                      {tk(`landing.pricing.${plan.key}`)}
                    </h3>
                    <p className="mt-5 flex items-baseline gap-2.5">
                      <span className="font-heading text-5xl font-semibold tracking-[-0.025em]">
                        {tk(`landing.pricing.${plan.key}Price`)}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {tk(`landing.pricing.${plan.key}Cadence`)}
                      </span>
                    </p>
                    <ul className="mt-8 flex flex-col divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                      {plan.items.map((item) => (
                        <li
                          key={item}
                          className="py-3.5 text-[0.9375rem] leading-snug first:pt-0 last:pb-0"
                        >
                          {tk(`landing.pricing.${plan.key}Items.${item}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Bezel>
              ))}
            </div>
            <p className="reveal-on-scroll mt-8 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t("landing.pricing.note")}
            </p>
          </div>
        </section>

        <section className="px-6 pb-28 lg:pb-36">
          <div className="mx-auto max-w-6xl">
            <h2 className="reveal-on-scroll max-w-2xl font-heading text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.02] font-semibold tracking-[-0.02em]">
              {t("landing.faq.title")}
            </h2>
            {/* Native disclosure: keyboard accessible and needs no JavaScript. */}
            <Bezel className="reveal-on-scroll mt-14 max-w-3xl">
              <FaqAccordion className="px-8 py-2 sm:px-10">
                {FAQS.map((faq) => (
                  <details
                    key={faq}
                    name="krypta-faq"
                    className="faq-item group border-b border-black/[0.06] py-6 last:border-b-0 dark:border-white/[0.07]"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-base font-medium [&::-webkit-details-marker]:hidden">
                      {tk(`landing.faq.${faq}.q`)}
                      <span
                        aria-hidden="true"
                        className="flex size-7 shrink-0 items-center justify-center rounded-full border border-black/[0.07] bg-black/[0.03] text-base leading-none text-brand transition-transform duration-500 ease-out group-open:rotate-45 dark:border-white/[0.09] dark:bg-white/[0.04]"
                      >
                        +
                      </span>
                    </summary>
                    <p className="faq-answer max-w-[62ch] pt-4 text-sm leading-relaxed text-muted-foreground">
                      {tk(`landing.faq.${faq}.a`)}
                    </p>
                  </details>
                ))}
              </FaqAccordion>
            </Bezel>
          </div>
        </section>

        <section className="px-6 pb-28 lg:pb-36">
          <Bezel tinted className="reveal-on-scroll mx-auto max-w-6xl">
            <div className="flex flex-col gap-8 px-8 py-14 sm:px-12 lg:flex-row lg:items-center lg:justify-between lg:py-16">
              <h2 className="max-w-lg font-heading text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.05] font-semibold tracking-[-0.02em]">
                {t("landing.cta.title")}
              </h2>
              {/*
               * self-start: in the stacked phone layout this column stretches
               * its children to full width, which left the label and arrow at
               * the left end of a long empty pill.
               */}
              <CtaLink
                href="/signup"
                className="shrink-0 self-start lg:self-center"
              >
                {t("landing.hero.create")}
              </CtaLink>
            </div>
          </Bezel>
        </section>
      </main>

      <footer className="border-t border-black/[0.06] px-6 dark:border-white/[0.07]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 py-10 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 font-heading text-base font-semibold tracking-tight"
          >
            <KryptaLogo className="h-5 w-auto text-brand" />
            krypta
          </Link>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link
              href="/security"
              className="text-sm text-muted-foreground transition-opacity duration-150 ease-out hover:opacity-70"
            >
              {t("landing.footer.security")}
            </Link>
            {/*
              Only linked when this instance has named an operator, because
              that is the only case where the pages exist. See lib/legal.ts.
            */}
            {legal !== null && (
              <>
                <Link
                  href="/privacy"
                  className="text-sm text-muted-foreground transition-opacity duration-150 ease-out hover:opacity-70"
                >
                  {t("landing.footer.privacy")}
                </Link>
                <Link
                  href="/terms"
                  className="text-sm text-muted-foreground transition-opacity duration-150 ease-out hover:opacity-70"
                >
                  {t("landing.footer.terms")}
                </Link>
              </>
            )}
            <a
              href="https://github.com/snsnf/krypta"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground transition-opacity duration-150 ease-out hover:opacity-70"
            >
              {t("landing.footer.github")}
            </a>
            <span className="font-mono text-xs tracking-wide text-muted-foreground">
              {t("landing.footer.tagline")}
            </span>
          </nav>
        </div>
      </footer>
    </div>
  )
}
