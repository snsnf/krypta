import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { ProseDocument } from "@/components/prose-document"
import { appTranslator } from "@/lib/app-translator"
import { getAppLanguage } from "@/lib/app-locale-server"
import { legalIdentity } from "@/lib/legal"
import { TERMS } from "@/lib/legal-content/terms"

/*
 * The terms of service, served only by an instance that has named its
 * operator. See `lib/legal.ts` for why that is configuration rather than
 * shipped text, and lib/legal-content/terms.ts for the text itself.
 *
 * The same rule as the privacy page applies: a claim there that the code does
 * not back is a promise made to a paying user that the service does not keep.
 * The limits, the billing behaviour and the recovery warning are all
 * descriptions of what the software actually does, and they change when it
 * does.
 */
export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const doc = TERMS[await getAppLanguage()]
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: "/terms" },
  }
}

export default async function TermsPage() {
  const identity = legalIdentity()
  if (identity === null) notFound()
  const language = await getAppLanguage()

  return (
    <ProseDocument
      doc={TERMS[language]}
      vars={{ entity: identity.entity, email: identity.contactEmail }}
      updatedLabel={appTranslator(language)("legal.lastUpdated")}
    />
  )
}
