import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import {
  ProseLead,
  ProseList,
  ProsePage,
  ProseSection,
  ProseText,
} from "@/components/prose-page"
import { legalIdentity } from "@/lib/legal"

/*
 * The terms of service, served only by an instance that has named its
 * operator. See `lib/legal.ts` for why that is configuration rather than
 * shipped text.
 *
 * The same rule as the privacy page applies: a claim here that the code does
 * not back is a promise made to a paying user that the service does not keep.
 * The limits, the billing behaviour and the recovery warning below are all
 * descriptions of what the software actually does, and they change when it
 * does.
 */
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The terms you agree to when you use this instance, including what happens to your data and what we cannot do for you.",
  alternates: { canonical: "/terms" },
}

const UPDATED = "18 September 2026"

const PROHIBITED = [
  "Collecting credentials, payment details or other secrets under a false identity. A form that impersonates a bank, an employer or a public body is phishing, and encryption makes it more convincing rather than more acceptable.",
  "Distributing malware, including as an attachment to a form you control.",
  "Collecting data you have no lawful basis to collect, or using a form to harass, defraud or endanger anyone.",
  "Attacking the service: probing for vulnerabilities on this instance rather than your own, defeating rate limits, or attempting to reach other accounts. Security research is welcome against an instance you run yourself.",
  "Reselling access in a way designed to work around account limits.",
]

export default function TermsPage() {
  const identity = legalIdentity()
  if (identity === null) notFound()

  return (
    <ProsePage title="Terms" updated={UPDATED}>
      <ProseLead>
        These terms are between you and {identity.entity}, who operates this
        instance. By creating an account or using the service you agree to them.
        If you do not, please do not use the service.
      </ProseLead>

      <ProseSection title="Your account">
        <ProseText>
          You are responsible for what happens under your account and for
          keeping your password, your vault recovery code and your devices to
          yourself. You must be old enough to enter a contract where you live,
          and the details you give us must be accurate enough that we can reach
          you.
        </ProseText>
        <ProseText>
          <strong className="font-medium text-foreground">
            We cannot recover your data if you lose both your password and your
            vault recovery code.
          </strong>{" "}
          This is not a support policy we could make an exception to. Your data
          is encrypted with keys derived from those secrets and we hold neither.
          There is no reset that recovers content, no administrator with a way
          in, and no copy of your key held anywhere for a rainy day. While you
          can still sign in you can generate a fresh vault recovery code from
          settings, so losing the code alone is survivable. Losing both is not.
          The{" "}
          <Link
            href="/security"
            className="text-foreground underline underline-offset-4 transition-opacity duration-150 ease-out hover:opacity-70"
          >
            security page
          </Link>{" "}
          explains why.
        </ProseText>
      </ProseSection>

      <ProseSection title="Your content is yours">
        <ProseText>
          Your forms, your responses and your files remain yours. We claim no
          licence over them beyond storing and transmitting the encrypted
          material so the service works, which is all we are technically able to
          do with it.
        </ProseText>
        <ProseText>
          Because you decide what your forms collect, you are responsible for
          collecting it lawfully: for telling respondents what you are gathering
          and why, for having a basis to gather it, and for answering
          respondents who ask you about their own answers. We cannot answer for
          you, since we cannot read what you collected.
        </ProseText>
      </ProseSection>

      <ProseSection title="What you must not use it for">
        <ProseList items={PROHIBITED} />
        <ProseText>
          How this is enforced is worth being straight about. We cannot read
          form content, so we do not monitor it and we could not pre-screen it
          if we wanted to. We act on reports, and the only tools we have are
          blunt ones at the level of an account or a form. Encryption is there
          to protect people from us and from whoever takes our database, not to
          shelter abuse from consequences.
        </ProseText>
      </ProseSection>

      <ProseSection title="Plans, payment and limits">
        <ProseText>
          There is a free plan and a paid plan. The price, the billing period
          and what each plan includes are shown at checkout, and the paid plan
          renews automatically until you cancel. You can cancel at any time from
          the billing portal, and access continues to the end of the period you
          have paid for. Payments are handled by our payment processor; we never
          receive your card details.
        </ProseText>
        <ProseText>
          Plans carry limits on open forms, stored files and responses per
          month. Reaching a limit stops the account adding more: creating or
          reopening a form is refused, and a form may stop accepting responses.
          It never deletes anything.
        </ProseText>
        <ProseText>
          That last point holds when a subscription ends too, whether you cancel
          or a payment fails. Nothing you have stored is deleted on downgrade.
          Choosing what to remove would mean ranking your titles, responses and
          filenames by importance, and all of it is ciphertext to us. An account
          past its limits stops being able to add; it never stops being able to
          read what it already has.
        </ProseText>
        <ProseText>
          If we change prices, we will tell account holders before the change
          applies to them.
        </ProseText>
      </ProseSection>

      <ProseSection title="Availability">
        <ProseText>
          We work to keep the service up and to keep your encrypted data safe,
          including backups held off the server. We do not promise an uptime
          figure, and we will take the service down for maintenance when it
          needs it. Keep your own copies of anything you cannot afford to lose:
          responses export as CSV from the dashboard.
        </ProseText>
      </ProseSection>

      <ProseSection title="Suspending or closing an account">
        <ProseText>
          You can stop using the service at any time and ask us to close your
          account by writing to {identity.contactEmail}. We may suspend or close
          an account that breaks these terms, that is being used to harm
          someone, or where we are legally required to. Except where the
          circumstances make it impossible or unlawful, we will tell you why and
          give you a chance to export your data first.
        </ProseText>
      </ProseSection>

      <ProseSection title="The software and the service">
        <ProseText>
          The software is open source under the AGPL, and you are free to read
          it, change it and run your own instance under that licence. These
          terms cover the hosted service we operate, not the software licence,
          and nothing here takes away a right the licence gives you.
        </ProseText>
      </ProseSection>

      <ProseSection title="Liability">
        <ProseText>
          The service is provided as it is. To the extent the law allows, we
          exclude implied warranties and are not liable for indirect or
          consequential loss, for lost profits, or for data you can no longer
          decrypt because the secrets that open it were lost. Where we are
          liable, our liability is limited to what you paid us in the twelve
          months before the claim.
        </ProseText>
        <ProseText>
          Nothing here limits liability that cannot be limited by law, including
          for death or personal injury caused by negligence, or for fraud. If
          you are a consumer, your statutory rights are unaffected.
        </ProseText>
      </ProseSection>

      <ProseSection title="Changes">
        <ProseText>
          We may update these terms. If a change matters to you, the date at the
          top changes and we will tell account holders before it takes effect.
          Continuing to use the service after that means you accept the new
          terms.
        </ProseText>
      </ProseSection>

      <ProseSection title="Contact">
        <ProseText>
          Write to {identity.contactEmail}. The{" "}
          <Link
            href="/privacy"
            className="text-foreground underline underline-offset-4 transition-opacity duration-150 ease-out hover:opacity-70"
          >
            privacy policy
          </Link>{" "}
          covers what we store and how to ask for it.
        </ProseText>
      </ProseSection>
    </ProsePage>
  )
}
