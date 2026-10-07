"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon, RotateClockwiseIcon } from "@hugeicons/core-free-icons"
import { HealthPanels, formatTimestamp } from "@/components/admin/health-panels"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { useAppLanguage, useAppT } from "@/lib/app-i18n"
import { getAdminHealth, type AdminHealth } from "@/lib/admin-health"

export default function AdminHealthPage() {
  const t = useAppT()
  const language = useAppLanguage()

  const [health, setHealth] = useState<AdminHealth | null>(null)
  const [error, setError] = useState(false)
  const [pending, setPending] = useState(false)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    getAdminHealth()
      .then((result) => {
        if (cancelled) return
        setHealth(result)
        setCheckedAt(new Date())
        setError(false)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function refresh(): void {
    setPending(true)
    getAdminHealth()
      .then((result) => {
        setHealth(result)
        setCheckedAt(new Date())
        setError(false)
      })
      .catch(() => {
        if (health === null) setError(true)
        toast.add({ title: t("admin.health.refreshFailed"), type: "error" })
      })
      .finally(() => setPending(false))
  }

  if (error) {
    return (
      <section>
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          {t("admin.health.title")}
        </h1>
        <p className="mt-6 text-sm text-muted-foreground">
          {t("admin.health.loadFailed")}
        </p>
        <Button className="mt-3" size="sm" onClick={refresh}>
          {t("common.retry")}
        </Button>
      </section>
    )
  }

  if (health === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("admin.health.loadingHealth")}
      </p>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t("admin.health.version", {
            version: health.version,
            time:
              checkedAt === null
                ? "-"
                : formatTimestamp(checkedAt.toISOString(), language),
          })}
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={refresh}
        >
          <HugeiconsIcon
            icon={pending ? Loading03Icon : RotateClockwiseIcon}
            size={14}
            className={pending ? "animate-spin" : undefined}
            data-icon="inline-start"
          />
          {t("admin.health.refresh")}
        </Button>
      </div>
      <div className="mt-4">
        <HealthPanels health={health} />
      </div>
    </div>
  )
}
