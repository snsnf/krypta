import Link from "next/link"
import { KryptaLogo } from "@/components/krypta-logo"

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-6 py-16">
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
