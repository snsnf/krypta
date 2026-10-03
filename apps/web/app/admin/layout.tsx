import type { Metadata } from "next"
import type { ReactNode } from "react"
import { AdminShell } from "@/components/admin/admin-shell"
import { appTranslator } from "@/lib/app-translator"
import { getAppLanguage } from "@/lib/app-locale-server"

export async function generateMetadata(): Promise<Metadata> {
  const t = appTranslator(await getAppLanguage())
  return {
    title: t("meta.administration"),
    robots: { index: false, follow: false },
  }
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>
}
