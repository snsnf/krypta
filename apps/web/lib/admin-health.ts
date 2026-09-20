import { apiFetch } from "./api"

interface HealthProbe {
  reachable: boolean
  latency_ms: number | null
}

export interface AdminHealth {
  dependencies: {
    postgres: HealthProbe
    redis: HealthProbe
    storage: HealthProbe
    mail: HealthProbe
  }
  backlogs: {
    notifications: {
      due: number
      backing_off: number
      oldest_pending_at: string | null
    }
    attachments: {
      cleanup_pending: number
      stale_uploads: number
      oldest_pending_at: string | null
    }
    invitations: { sending: number; delivery_failed: number }
  }
  configuration: {
    billing: string
    mail: string
    passkeys: string
    backups: string
  }
}

/*
 * `/admin/health`, never `/admin/metrics` or anything with telemetry, stats
 * or analytics in it. Filter lists block those patterns, and the failure is
 * silent: the request never leaves the browser and the panel spins forever
 * while the server looks innocent.
 */
export async function getAdminHealth(): Promise<AdminHealth> {
  return apiFetch<AdminHealth>("/admin/health")
}

type Tone = "ok" | "warn" | "neutral"

/**
 * How a configuration value should read.
 *
 * The states are not pass or fail. Billing being inert is correct for a
 * self-hosted instance, so it reads as information; backups being local only
 * means the script runs and nothing leaves the server, which is worth a
 * warning; a partial Stripe configuration is a misconfiguration rather than
 * a choice.
 */
export function describeConfiguration(
  key: string,
  value: string
): { tone: Tone; label: string } {
  if (value === "configured") return { tone: "ok", label: "Configured" }
  if (value === "inert") return { tone: "neutral", label: "Not in use" }
  if (value === "defaulted") return { tone: "neutral", label: "Using default" }
  if (value === "local_only") {
    return { tone: "warn", label: "Local only, nothing leaves this server" }
  }
  if (value === "partial") {
    return { tone: "warn", label: "Partly configured" }
  }
  if (value === "missing") return { tone: "warn", label: "Not configured" }
  return { tone: "neutral", label: value }
}
