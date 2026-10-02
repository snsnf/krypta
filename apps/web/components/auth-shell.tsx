import Link from "next/link"
import { KryptaLogo } from "@/components/krypta-logo"
import { AuthLanguageToggle } from "@/components/language-switcher"

export function AuthShell({
  children,
  showLanguageToggle = true,
}: {
  children: React.ReactNode
  /** Off for a screen whose text is not translated yet, so choosing Arabic there would only mirror English. */
  showLanguageToggle?: boolean
}) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center px-6 py-16">
      {showLanguageToggle && <AuthLanguageToggle />}
      <Link
        href="/"
        className="mb-10 flex items-center gap-2 font-heading text-lg font-medium tracking-tight transition-opacity duration-150 ease-out hover:opacity-70"
      >
        <KryptaLogo className="h-7 w-auto text-brand" />
        krypta
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
