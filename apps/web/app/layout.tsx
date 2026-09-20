import type { Metadata } from "next"
import { headers } from "next/headers"
import { Geist_Mono, Outfit, Schibsted_Grotesk } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toast"
import { cn } from "@/lib/utils"

const bodyFont = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
})

// Outfit for display, Schibsted Grotesk for text, Geist Mono for labels and
// ciphertext. The pairing is the point: Outfit is geometric, so the face
// beside it has to be a neutral grotesque rather than a second geometric, or
// the two read as one family drawn badly. Outfit is also weakest at the sizes
// body copy lives at, which is why nothing below a heading is set in it.
const headingFont = Outfit({
  subsets: ["latin"],
  variable: "--font-heading",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

// SITE_URL rather than NEXT_PUBLIC_SITE_URL: this is read on the server, and
// a NEXT_PUBLIC_ value would be compiled into the browser bundle, baking the
// hostname that built the image into every copy of it. Read here at runtime,
// one published image serves any domain.
const siteUrl = process.env.SITE_URL ?? "http://localhost:3000"

export const metadata: Metadata = {
  // Absolute base for OG/Twitter asset URLs; crawlers reject relative ones.
  metadataBase: new URL(siteUrl),
  title: {
    default: "krypta",
    template: "%s | krypta",
  },
  description:
    "Encrypted forms. Every response is sealed in the visitor's browser, so we store ciphertext and only you hold the key.",
  applicationName: "krypta",
  openGraph: {
    type: "website",
    siteName: "krypta",
    title: "krypta",
    description:
      "Encrypted forms. Every response is sealed in the visitor's browser, so we store ciphertext and only you hold the key.",
    url: siteUrl,
  },
  twitter: {
    card: "summary_large_image",
    title: "krypta",
    description:
      "Encrypted forms. Every response is sealed in the visitor's browser, so we store ciphertext and only you hold the key.",
  },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // next-themes writes an inline script to set the theme before first paint,
  // which the nonce CSP blocks unless it is given the same nonce proxy.ts
  // generated for this request.
  const nonce = (await headers()).get("x-nonce") ?? undefined
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        bodyFont.variable,
        headingFont.variable
      )}
    >
      <body>
        <ThemeProvider nonce={nonce}>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
