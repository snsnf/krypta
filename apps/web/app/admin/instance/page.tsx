"use client"

import { useEffect, useState } from "react"
import { InstanceSettings } from "@/components/admin/instance-settings"
import { Button } from "@/components/ui/button"
import { getAdminSettings, type AdminSettings } from "@/lib/admin"

export default function AdminInstancePage() {
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
          Instance
        </h1>
        <p className="mt-6 text-sm text-muted-foreground">
          Could not load instance settings.
        </p>
        <Button
          className="mt-3"
          size="sm"
          onClick={() => window.location.reload()}
        >
          Retry
        </Button>
      </section>
    )
  }

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">Loading settings...</p>
  }

  return <InstanceSettings settings={settings} onSaved={setSettings} />
}
