import { describeConfiguration, type AdminHealth } from "@/lib/admin-health"
import {
  translateKey,
  useAppLanguage,
  useAppT,
  type AppTranslator,
} from "@/lib/app-i18n"
import { appFormatters } from "@/lib/app-format"
import type { AppLanguage } from "@/lib/app-locale"

interface HealthPanelsProps {
  health: AdminHealth
}

type Probe = { reachable: boolean; latency_ms: number | null }

function probeLabel(probe: Probe, t: AppTranslator): string {
  if (!probe.reachable) return t("admin.health.unreachable")
  if (probe.latency_ms === null) return t("admin.health.reachable")
  return t("admin.health.reachableMs", { ms: probe.latency_ms })
}

function probeBadgeClass(probe: Probe): string {
  return probe.reachable
    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : "bg-destructive/10 text-destructive"
}

function toneBadgeClass(tone: "ok" | "warn" | "neutral"): string {
  if (tone === "ok")
    return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
  if (tone === "warn")
    return "bg-amber-500/10 text-amber-600 dark:text-amber-400"
  return "bg-muted text-muted-foreground"
}

// `time`'s RFC3339 serializer has rendered as "Invalid Date" in this project
// before; the formatter returns "" for anything it cannot parse.
export function formatTimestamp(
  value: string | null,
  language: AppLanguage = "en"
): string {
  if (value === null) return "-"
  return appFormatters(language).date(value, true) || "-"
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
  const t = useAppT()
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      <span
        className={`rounded-full px-2 py-1 text-xs font-medium ${
          notApplicable ? toneBadgeClass("neutral") : probeBadgeClass(probe)
        }`}
      >
        {notApplicable ?? probeLabel(probe, t)}
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
  const t = useAppT()
  const described = describeConfiguration(configKey, value)
  const known = [
    "configured",
    "inert",
    "defaulted",
    "local_only",
    "partial",
    "missing",
  ]
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      <span
        className={`rounded-full px-2 py-1 text-xs font-medium ${toneBadgeClass(described.tone)}`}
      >
        {known.includes(value)
          ? translateKey(t, `admin.health.config.${value}`)
          : described.label}
      </span>
    </div>
  )
}

export function HealthPanels({ health }: HealthPanelsProps) {
  const { dependencies, backlogs, configuration } = health
  const t = useAppT()
  const language = useAppLanguage()
  const when = (value: string | null) => formatTimestamp(value, language)

  return (
    <section>
      <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
        {t("admin.health.title")}
      </h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {t("admin.health.body")}
      </p>

      <div className="mt-8 max-w-2xl rounded-xl border border-border p-4 sm:p-5">
        <h2 className="text-sm font-medium">
          {t("admin.health.dependencies")}
        </h2>
        <div className="mt-4 grid gap-3">
          <DependencyRow
            label={t("admin.health.postgres")}
            probe={dependencies.postgres}
          />
          <DependencyRow
            label={t("admin.health.redis")}
            probe={dependencies.redis}
          />
          <DependencyRow
            label={t("admin.health.storage")}
            probe={dependencies.storage}
          />
          <DependencyRow
            label={t("admin.health.mail")}
            probe={dependencies.mail}
            notApplicable={
              configuration.mail === "missing"
                ? t("admin.health.noRelay")
                : undefined
            }
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("admin.health.reachabilityNote")}
        </p>
      </div>

      <div className="mt-6 max-w-2xl rounded-xl border border-border p-4 sm:p-5">
        <h2 className="text-sm font-medium">{t("admin.health.background")}</h2>
        <div className="mt-4 grid gap-4">
          <div>
            <p className="text-sm font-medium">
              {t("admin.health.notifications")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("admin.health.dueBacking", {
                due: backlogs.notifications.due,
                backing: backlogs.notifications.backing_off,
              })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("admin.health.oldest", {
                time: when(backlogs.notifications.oldest_pending_at),
              })}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">
              {t("admin.health.attachments")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("admin.health.cleanup", {
                cleanup: backlogs.attachments.cleanup_pending,
                stale: backlogs.attachments.stale_uploads,
              })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("admin.health.oldest", {
                time: when(backlogs.attachments.oldest_pending_at),
              })}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">
              {t("admin.health.invitations")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("admin.health.sendingFailed", {
                sending: backlogs.invitations.sending,
                failed: backlogs.invitations.delivery_failed,
              })}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 max-w-2xl rounded-xl border border-border p-4 sm:p-5">
        <h2 className="text-sm font-medium">
          {t("admin.health.configuration")}
        </h2>
        <div className="mt-4 grid gap-3">
          <ConfigurationRow
            configKey="billing"
            label={t("admin.health.billing")}
            value={configuration.billing}
          />
          <ConfigurationRow
            configKey="mail"
            label={t("admin.health.mail")}
            value={configuration.mail}
          />
          <ConfigurationRow
            configKey="passkeys"
            label={t("admin.health.passkeys")}
            value={configuration.passkeys}
          />
          <ConfigurationRow
            configKey="backups"
            label={t("admin.health.backups")}
            value={configuration.backups}
          />
        </div>
      </div>
    </section>
  )
}
