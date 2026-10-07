"use client"

import { useEffect, useState } from "react"
import { InstanceSettings } from "@/components/admin/instance-settings"
import { Button } from "@/components/ui/button"
import { useAppT } from "@/lib/app-i18n"
import { getAdminSettings, type AdminSettings } from "@/lib/admin"

export default function AdminInstancePage() {
  const t = useAppT()

  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    getAdminSettings()
      .then((result) => {
        if (!cancelled) setSettings(result)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <section>
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          {t("admin.instance.title")}
        </h1>
        <p className="mt-6 text-sm text-muted-foreground">
          {t("admin.instance.loadFailed")}
        </p>
        <Button
          className="mt-3"
          size="sm"
          onClick={() => window.location.reload()}
        >
          {t("common.retry")}
        </Button>
      </section>
    )
  }

  if (settings === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("admin.instance.loadingSettings")}
      </p>
    )
  }

  return <InstanceSettings settings={settings} onSaved={setSettings} />
}
