import type { Metadata } from "next"
import type { ReactNode } from "react"

// The page itself is a client component and cannot declare metadata, so the
// title and robots policy live here.
export const metadata: Metadata = {
  title: "Recover your vault",
  robots: { index: false, follow: false },
}

export default function Layout({ children }: { children: ReactNode }) {
  return children
}
