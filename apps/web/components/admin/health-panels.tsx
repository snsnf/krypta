import { describeConfiguration, type AdminHealth } from "@/lib/admin-health"

interface HealthPanelsProps {
  health: AdminHealth
}

type Probe = { reachable: boolean; latency_ms: number | null }

function probeLabel(probe: Probe): string {
  if (!probe.reachable) return "Unreachable"
  if (probe.latency_ms === null) return "Reachable"
  return `Reachable, ${probe.latency_ms} ms`
}

function probeBadgeClass(probe: Probe): string {
  return probe.reachable
    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : "bg-destructive/10 text-destructive"
}

function toneBadgeClass(tone: "ok" | "warn" | "neutral"): string {
  if (tone === "ok") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
  if (tone === "warn") return "bg-amber-500/10 text-amber-600 dark:text-amber-400"
  return "bg-muted text-muted-foreground"
}

export function formatTimestamp(value: string | null): string {
  if (value === null) return "-"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "-"
  return parsed.toLocaleString()
}

function DependencyRow({
  label,
  probe,
  notApplicable,
}: {
  label: string
  probe: Probe
  notApplicable?: string
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      <span
        className={`rounded-full px-2 py-1 text-xs font-medium ${
          notApplicable ? toneBadgeClass("neutral") : probeBadgeClass(probe)
        }`}
      >
        {notApplicable ?? probeLabel(probe)}
      </span>
    </div>
  )
}

function ConfigurationRow({
  configKey,
  label,
  value,
}: {
  configKey: string
  label: string
  value: string
}) {
  const described = describeConfiguration(configKey, value)
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      <span
        className={`rounded-full px-2 py-1 text-xs font-medium ${toneBadgeClass(described.tone)}`}
      >
        {described.label}
      </span>
    </div>
  )
}

export function HealthPanels({ health }: HealthPanelsProps) {
  const { dependencies, backlogs, configuration } = health

  return (
    <section>
      <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
        Health
      </h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Dependency reachability and background work, checked on demand.
      </p>

      <div className="mt-8 max-w-2xl rounded-xl border border-border p-4 sm:p-5">
        <h2 className="text-sm font-medium">Dependencies</h2>
        <div className="mt-4 grid gap-3">
          <DependencyRow label="Postgres" probe={dependencies.postgres} />
          <DependencyRow label="Redis" probe={dependencies.redis} />
          <DependencyRow label="Object storage" probe={dependencies.storage} />
          <DependencyRow
            label="Mail"
            probe={dependencies.mail}
            notApplicable={
              configuration.mail === "missing" ? "No relay configured" : undefined
            }
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Reachability only. This does not prove an SMTP conversation,
          authentication, or delivery.
        </p>
      </div>

      <div className="mt-6 max-w-2xl rounded-xl border border-border p-4 sm:p-5">
        <h2 className="text-sm font-medium">Background work</h2>
        <div className="mt-4 grid gap-4">
          <div>
            <p className="text-sm font-medium">Notifications</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {backlogs.notifications.due} due,{" "}
              {backlogs.notifications.backing_off} backing off
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Oldest pending: {formatTimestamp(backlogs.notifications.oldest_pending_at)}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">Attachments</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {backlogs.attachments.cleanup_pending} pending cleanup,{" "}
              {backlogs.attachments.stale_uploads} stale uploads
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Oldest pending: {formatTimestamp(backlogs.attachments.oldest_pending_at)}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">Invitations</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {backlogs.invitations.sending} sending,{" "}
              {backlogs.invitations.delivery_failed} failed to deliver
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 max-w-2xl rounded-xl border border-border p-4 sm:p-5">
        <h2 className="text-sm font-medium">Configuration</h2>
        <div className="mt-4 grid gap-3">
          <ConfigurationRow
            configKey="billing"
            label="Billing"
            value={configuration.billing}
          />
          <ConfigurationRow
            configKey="mail"
            label="Mail"
            value={configuration.mail}
          />
          <ConfigurationRow
            configKey="passkeys"
            label="Passkeys"
            value={configuration.passkeys}
          />
          <ConfigurationRow
            configKey="backups"
            label="Backups"
            value={configuration.backups}
          />
        </div>
      </div>
    </section>
  )
}
