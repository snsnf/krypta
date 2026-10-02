import type { Metadata } from "next"
import type { ReactNode } from "react"
import { AppLocaleProvider } from "@/components/app-locale-provider"

// The page itself is a client component and cannot declare metadata, so the
// title and robots policy live here.
//
// The share card is the same for every form, and it has to be. A form's title
// lives in `forms.title_ciphertext`, and the key that opens it is in the URL
// fragment, which browsers never send and a crawler never has. No server can
// read the title, so the card says the one thing a respondent handed a link
// actually needs, and nothing about which form it is. The default description
// is written for someone choosing a product; this one is for someone about to
// answer a question.
const SHARED_FORM = {
  title: "Someone shared an encrypted form",
  description:
    "Your answers are encrypted in your browser before they are sent, so only the people running this form can read them.",
}

export const metadata: Metadata = {
  title: "Form",
  robots: { index: false, follow: false },
  // The image and the card size have to be repeated here. Declaring
  // `openGraph` at all replaces what the root layout set, and the picture the
  // file-based `opengraph-image.tsx` injects goes with it, which would turn a
  // shared form link into a preview with no image at all.
  openGraph: { ...SHARED_FORM, images: ["/opengraph-image"] },
  twitter: {
    ...SHARED_FORM,
    card: "summary_large_image",
    images: ["/opengraph-image"],
  },
}

/*
 * A public form must not take the viewer's app language: an Arabic browser
 * opening an English form still gets an English, left-to-right form. The
 * form's own surface applies the form's language on top of this.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div lang="en" dir="ltr" className="contents">
      <AppLocaleProvider language="en">{children}</AppLocaleProvider>
    </div>
  )
}
