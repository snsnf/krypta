import type { Metadata } from "next"
import type { ReactNode } from "react"

// The page itself is a client component and cannot declare metadata, so the
// title live here.
export const metadata: Metadata = {
  title: "Sign in",
  alternates: { canonical: "/login" },
  description:
    "Sign in to your krypta account to build encrypted forms and read the responses only you can decrypt.",
}

export default function Layout({ children }: { children: ReactNode }) {
  return children
}
