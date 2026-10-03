import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { ProseDocument } from "@/components/prose-document"
import { appTranslator } from "@/lib/app-translator"
import { getAppLanguage } from "@/lib/app-locale-server"
import { legalIdentity } from "@/lib/legal"
import { PRIVACY } from "@/lib/legal-content/privacy"

/*
 * The privacy policy, served only by an instance that has named its operator.
 * The text is in lib/legal-content/privacy.ts, in both languages.
 *
 * Every factual claim there has to stay true of the code, the same rule
 * `/security` follows. The difference is that this page is a promise rather
 * than a description, so a sentence that outruns the code is a false statement
 * made to a user about their own data. When a default, a retention period or a
 * stored field changes, the page changes with it.
 *
 * Rendered per request rather than prerendered, because the operator's details
 * are runtime configuration: prerendering would freeze whatever the build
 * machine happened to have into the output.
 */
export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const doc = PRIVACY[await getAppLanguage()]
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: "/privacy" },
  }
}

export default async function PrivacyPage() {
  const identity = legalIdentity()
  if (identity === null) notFound()
  const language = await getAppLanguage()

  return (
    <ProseDocument
      doc={PRIVACY[language]}
      vars={{ entity: identity.entity, email: identity.contactEmail }}
      updatedLabel={appTranslator(language)("legal.lastUpdated")}
    />
  )
}
