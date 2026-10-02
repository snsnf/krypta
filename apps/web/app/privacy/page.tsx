import type { Metadata } from "next"
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
 * The privacy policy, served only by an instance that has named its operator.
 *
 * Every factual claim here has to stay true of the code, the same rule
 * `/security` follows. The difference is that this page is a promise rather
 * than a description, so a sentence that outruns the code is a false statement
 * made to a user about their own data. When a default, a retention period or a
 * stored field changes, this page changes with it.
 *
 * Rendered per request rather than prerendered, because the operator's details
 * are runtime configuration: prerendering would freeze whatever the build
 * machine happened to have into the output.
 */
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What this instance stores, what it cannot read, and how to ask for your data.",
  alternates: { canonical: "/privacy" },
}

const UPDATED = "18 September 2026"

const ACCOUNT_DATA = [
  "Your email address. It identifies the account, receives the six-digit code that verifies it, and receives collaboration invitations and response notifications.",
  "A hash of a verifier derived from your password. Your password is not sent to the server and is not stored here in any form: the browser derives a key from it and sends a one-way verifier, which the server then hashes again with Argon2id.",
  "Wrapped copies of your account key, one for each way you unlock it. These are ciphertext that only your password, your vault recovery code or your passkey can open.",
  "If you enrol two-factor authentication, the TOTP secret, which has to be readable to check your codes, and hashes of your TOTP recovery codes. If you enrol a passkey, the credential it registered.",
  "Session records, which hold a hash of the session token rather than the token. Sessions expire after 30 days of not being used, and 90 days after they were created whatever happens.",
]

const CONTENT_DATA = [
  "Ciphertext for form titles, questions and responses, and the encrypted bytes of uploaded files. None of it can be read by this instance, its operator, its host or anyone served a copy of its database.",
  "The size of each uploaded file, because storage limits are counted against it. Ciphertext lengths for titles, questions and responses are padded, so those sizes say close to nothing about their contents.",
  "Timestamps, counts, and whether a form is accepting responses, along with its close date and response cap. A limit the server cannot read is a limit it cannot enforce.",
  "Who collaborates on which form and in what role, and the email address an invitation was sent to.",
]

const OPERATIONAL_DATA = [
  "IP addresses, used to count requests against rate limits. These counters are short-lived, they are not written to a request log for this purpose, and the login limiter counts against a hash of the address you typed rather than the address itself.",
  "Pending signups, held for 15 minutes so a verification code can be checked, and discarded whether or not it is used.",
  "If you subscribe to a paid plan, the customer and subscription identifiers issued by our payment processor, your plan, its status, and how many responses your account has received this month. Card details are handled by the payment processor and never reach this instance.",
]

export default function PrivacyPage() {
  const identity = legalIdentity()
  if (identity === null) notFound()

  return (
    <ProsePage title="Privacy" updated={UPDATED}>
      <ProseLead>
        This instance is operated by {identity.entity}. This page describes what
        it stores about you, what it is unable to read, and how to ask for
        something to be changed or removed.
      </ProseLead>
      <ProseText>
        The short version: form titles, questions, answers and uploaded files
        are encrypted in your browser before they are sent. We hold ciphertext
        and no key that opens it. That is not a policy commitment that could be
        revised later, it is a property of how the software is built, and it
        means a database dump, a stolen backup, a compromised host or a legal
        demand made to us yields ciphertext.
      </ProseText>

      <ProseSection title="What we hold about your account">
        <ProseList items={ACCOUNT_DATA} />
      </ProseSection>

      <ProseSection title="What we hold about your forms">
        <ProseText>
          Some metadata is unavoidable if the service is to work at all, and
          pretending otherwise would be dishonest.
        </ProseText>
        <ProseList items={CONTENT_DATA} />
      </ProseSection>

      <ProseSection title="What we hold to run the service">
        <ProseList items={OPERATIONAL_DATA} />
      </ProseSection>

      <ProseSection title="What we do not do">
        <ProseText>
          There is no analytics, no advertising, no profiling and no third-party
          tracking on this site. We do not sell or share personal data. Fonts
          are served from this origin rather than a font network, so opening a
          form does not hand your address to anyone else, and the pages load no
          third-party scripts.
        </ProseText>
        <ProseText>
          The only cookies are the ones that sign you in: a session cookie, and
          a short-lived cookie that carries a collaboration invitation while you
          accept it. If you choose a language, one more remembers that choice;
          it is not set unless you choose, and it holds only the language. All
          of them are restricted to this site and none is used to follow you
          anywhere.
        </ProseText>
      </ProseSection>

      <ProseSection title="If you are answering someone's form">
        <ProseText>
          You do not need an account and we do not ask who you are. Your answers
          are encrypted in your browser and sealed to the form, so only the
          people running that form can read them. We cannot read your answers,
          and we cannot find them for you: to us they are ciphertext with no
          name on it.
        </ProseText>
        <ProseText>
          That has a consequence worth stating plainly. The person who made the
          form decides what they collect and what they do with it, so a request
          to see, correct or delete your answers has to go to them rather than
          to us. We are not in a position to act on it, whatever we might wish.
        </ProseText>
        <ProseText>
          While you are part-way through a form, your answers are kept in your
          own browser so that closing the tab does not lose them. They stay on
          your device, are never sent to us in that form, are removed after 30
          days, and the form gives you a control that removes them immediately.
          On a shared computer, use it.
        </ProseText>
      </ProseSection>

      <ProseSection title="Who else processes this data">
        <ProseText>
          We use service providers to run the instance: a hosting provider for
          the servers, an object storage provider for encrypted file uploads, an
          email provider to deliver verification codes, invitations and
          notifications, and a payment processor for paid plans. They receive
          only what their job requires, and the encrypted material stays
          encrypted in their hands too.
        </ProseText>
        <ProseText>
          Notification emails carry a count and a link, never the title of a
          form or anything from a response, because those are encrypted and we
          could not put them in an email if we wanted to.
        </ProseText>
      </ProseSection>

      <ProseSection title="How long we keep it">
        <ProseText>
          Your forms, responses and uploads stay until you delete them. You can
          delete a response or a whole form from the dashboard, and deleting a
          form deletes the responses and files attached to it.
        </ProseText>
        <ProseText>
          Encrypted database backups are kept for a short period so the service
          can be restored after a failure, and a deletion works through to those
          backups as they age out. Rate-limit counters and pending signups are
          transient and measured in minutes to hours. Sessions expire as
          described above.
        </ProseText>
        <ProseText>
          To close your account, write to us at {identity.contactEmail}. There
          is no self-service button for this yet, so it is a request we carry
          out by hand rather than one you can complete on your own, and we say
          so rather than implying otherwise. Deleting an account deletes the
          encrypted material only that account holds.
        </ProseText>
      </ProseSection>

      <ProseSection title="Your rights">
        <ProseText>
          You can ask for a copy of what we hold about you, ask us to correct
          it, ask us to delete it, or object to how we use it. Write to{" "}
          {identity.contactEmail} and we will answer within one month.
        </ProseText>
        <ProseText>
          Two honest limits apply. Anything encrypted can be exported by you
          from inside the app, where the keys are, and the export you make there
          is more useful than anything we could assemble, since ours would be
          ciphertext. And we cannot correct or delete something we cannot
          identify: answers submitted to a form someone else runs are theirs to
          act on.
        </ProseText>
        <ProseText>
          If you think we have handled your data badly, please tell us first,
          and know that you can also complain to the data protection authority
          where you live.
        </ProseText>
      </ProseSection>

      <ProseSection title="Changes and contact">
        <ProseText>
          If this policy changes in a way that matters, the date at the top
          changes with it and we will say so to account holders before it takes
          effect. Questions, requests and complaints go to{" "}
          {identity.contactEmail}.
        </ProseText>
      </ProseSection>
    </ProsePage>
  )
}
