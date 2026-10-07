import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { useDirection } from "@base-ui/react/direction-provider"

vi.mock("@/lib/app-i18n", async () => vi.importActual("../lib/app-i18n"))
vi.mock("@/lib/form-language", async () => vi.importActual("../lib/form-language"))
vi.mock("@/lib/app-format", async () => vi.importActual("../lib/app-format"))

import { AppLocaleProvider } from "./app-locale-provider"
import { useAppLanguage } from "../lib/app-i18n"

function Probe() {
  return (
    <span data-probe>
      {useAppLanguage()}:{useDirection()}
    </span>
  )
}

describe("AppLocaleProvider", () => {
  it("tells the app and Base UI the language and its direction", () => {
    const ar = renderToStaticMarkup(
      <AppLocaleProvider language="ar">
        <Probe />
      </AppLocaleProvider>
    )
    expect(ar).toContain("ar:rtl")
    const en = renderToStaticMarkup(
      <AppLocaleProvider language="en">
        <Probe />
      </AppLocaleProvider>
    )
    expect(en).toContain("en:ltr")
  })
})
