import type { ReactNode } from "react"
import { AppLocaleProvider } from "@/components/app-locale-provider"

/*
 * A public form must not take the viewer's app language: an Arabic browser
 * opening an English form still gets an English, left-to-right form. The
 * form's own surface applies the form's language on top of this.
 */
export default function RespondentLayout({ children }: { children: ReactNode }) {
  return (
    <div lang="en" dir="ltr" className="contents">
      <AppLocaleProvider language="en">{children}</AppLocaleProvider>
    </div>
  )
}
