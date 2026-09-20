import type { Metadata } from "next"
import type { ReactNode } from "react"

// The page itself is a client component and cannot declare metadata, so the
// title live here.
export const metadata: Metadata = {
  title: "Create an account",
  alternates: { canonical: "/signup" },
  description:
    "Create a krypta account. Your key is made in your browser and never leaves it.",
}

export default function Layout({ children }: { children: ReactNode }) {
  return children
}
