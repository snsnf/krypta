import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock("@/lib/app-i18n", async () => vi.importActual("./app-i18n"))
vi.mock("@/lib/app-format", async () => vi.importActual("./app-format"))
vi.mock("./api", () => ({ apiFetch: mocks.apiFetch }))
// health-panels.tsx imports from "@/lib/admin-health", which is unresolvable
// under this repo's vitest (see apps/web/CLAUDE.md). Route it to the real
// module by its relative path so formatTimestamp's own real behavior, and
// the real describeConfiguration it depends on, are exercised.
vi.mock("@/lib/admin-health", async () => vi.importActual("./admin-health"))

import { getAdminHealth, describeConfiguration } from "./admin-health"
import { formatTimestamp } from "../components/admin/health-panels"

beforeEach(() => vi.clearAllMocks())

describe("getAdminHealth", () => {
  it("asks the health route, never one named metrics or telemetry", async () => {
    mocks.apiFetch.mockResolvedValue({
      dependencies: {},
      backlogs: {},
      configuration: {},
    })
    await getAdminHealth()
    const path = mocks.apiFetch.mock.calls[0][0] as string
    expect(path).toBe("/admin/health")
    for (const blocked of ["metrics", "telemetry", "stats", "analytics"]) {
      expect(path).not.toContain(blocked)
    }
  })
})

describe("describeConfiguration", () => {
  it("treats a deliberate choice as information, not a fault", () => {
    // A self-hosted instance with no Stripe is correct, not broken.
    expect(describeConfiguration("billing", "inert").tone).toBe("neutral")
    expect(describeConfiguration("backups", "local_only").tone).toBe("warn")
    expect(describeConfiguration("billing", "partial").tone).toBe("warn")
    expect(describeConfiguration("mail", "configured").tone).toBe("ok")
  })
})

describe("formatTimestamp", () => {
  // This is the exact shape that shipped broken once: `time`'s default
  // serialization of an OffsetDateTime read back as "Invalid Date" and the
  // field rendered blank on a silently closed form. A regression here must
  // fail loudly rather than render the literal string "Invalid Date".
  it("renders a valid RFC3339 string as a readable date", () => {
    const rendered = formatTimestamp("2026-09-08T12:34:56Z")
    expect(rendered).not.toBe("Invalid Date")
    expect(rendered).not.toBe("-")
    expect(rendered.length).toBeGreaterThan(0)
  })

  it("renders null as a dash", () => {
    expect(formatTimestamp(null)).toBe("-")
  })

  it("never renders the string Invalid Date, even for malformed input", () => {
    expect(formatTimestamp("not a real timestamp")).not.toBe("Invalid Date")
  })
})
