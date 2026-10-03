import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/admin-health", async () =>
  vi.importActual("../../lib/admin-health")
)
vi.mock("@/lib/app-i18n", async () => vi.importActual("../../lib/app-i18n"))
vi.mock("@/lib/app-format", async () => vi.importActual("../../lib/app-format"))

import { AppLanguageContext } from "../../lib/app-i18n"
import type { AdminHealth } from "../../lib/admin-health"
import { HealthPanels } from "./health-panels"

const health = {
  version: "1.0.0",
  dependencies: {
    postgres: { reachable: true, latency_ms: 4 },
    redis: { reachable: false, latency_ms: null },
    storage: { reachable: true, latency_ms: null },
    mail: { reachable: false, latency_ms: null },
  },
  backlogs: {
    notifications: { due: 2, backing_off: 1, oldest_pending_at: null },
    attachments: {
      cleanup_pending: 0,
      stale_uploads: 3,
      oldest_pending_at: null,
    },
    invitations: { sending: 1, delivery_failed: 0 },
  },
  configuration: {
    billing: "inert",
    mail: "missing",
    passkeys: "configured",
    backups: "local_only",
  },
} as unknown as AdminHealth

function render(language: "en" | "ar") {
  return renderToStaticMarkup(
    <AppLanguageContext.Provider value={language}>
      <HealthPanels health={health} />
    </AppLanguageContext.Provider>
  )
}

describe("HealthPanels", () => {
  it("is unchanged in English", () => {
    const markup = render("en")
    expect(markup).toContain("Reachable, 4 ms")
    expect(markup).toContain("2 due, 1 backing off")
    expect(markup).toContain("Local only, nothing leaves this server")
  })

  it("is in Arabic when the app is, with Western digits", () => {
    const markup = render("ar")
    expect(markup).toContain("الصحة")
    expect(markup).toContain("يمكن الوصول، 4 مللي ثانية")
    expect(markup).toContain("لا يمكن الوصول")
    expect(markup).not.toMatch(/[٠-٩]/)
    expect(markup).not.toContain("Dependencies")
  })
})
