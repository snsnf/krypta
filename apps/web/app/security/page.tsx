import type { Metadata } from "next"
import { ProseDocument } from "@/components/prose-document"
import { appTranslator } from "@/lib/app-translator"
import { getAppLanguage } from "@/lib/app-locale-server"
import { SECURITY } from "@/lib/legal-content/security"

/*
 * The public half of SECURITY.md, for someone deciding whether to trust an
 * instance before they read any code. The text is in
 * lib/legal-content/security.ts, in both languages.
 *
 * It may say less than SECURITY.md and must never say more, and the limits
 * there are not a disclaimer to be softened later: a reader who finds them
 * listed plainly has a reason to believe the guarantee above them. Changing a
 * default, a header or a limit means changing the code, SECURITY.md and this
 * page together.
 */
export async function generateMetadata(): Promise<Metadata> {
  const doc = SECURITY[await getAppLanguage()]
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: "/security" },
  }
}

export default async function SecurityPage() {
  const language = await getAppLanguage()
  return (
    <ProseDocument
      doc={SECURITY[language]}
      updatedLabel={appTranslator(language)("legal.lastUpdated")}
    />
  )
}
