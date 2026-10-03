import type { Metadata } from "next"
import type { ReactNode } from "react"
import { appTranslator } from "@/lib/app-translator"
import { getAppLanguage } from "@/lib/app-locale-server"

// The page itself is a client component and cannot declare metadata, so the
// title live here, worded in the app's language.
export async function generateMetadata(): Promise<Metadata> {
  const t = appTranslator(await getAppLanguage())
  return {
    title: t("meta.signUp"),
    alternates: { canonical: "/signup" },
    description: t("meta.signUpDescription"),
  }
}

export default function Layout({ children }: { children: ReactNode }) {
  return children
}
