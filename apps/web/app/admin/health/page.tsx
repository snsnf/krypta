"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon, RotateClockwiseIcon } from "@hugeicons/core-free-icons"
import { HealthPanels } from "@/components/admin/health-panels"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { getAdminHealth, type AdminHealth } from "@/lib/admin-health"

export default function AdminHealthPage() {
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
        toast.add({ title: "Could not refresh health", type: "error" })
      })
      .finally(() => setPending(false))
  }

  if (error) {
    return (
      <section>
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          Health
        </h1>
        <p className="mt-6 text-sm text-muted-foreground">
          Could not load instance health.
        </p>
        <Button className="mt-3" size="sm" onClick={refresh}>
          Retry
        </Button>
      </section>
    )
  }

  if (health === null) {
    return <p className="text-sm text-muted-foreground">Loading health...</p>
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Checked at{" "}
          {checkedAt === null ? "-" : checkedAt.toLocaleTimeString()}
        </p>
        <Button size="sm" variant="secondary" disabled={pending} onClick={refresh}>
          <HugeiconsIcon
            icon={pending ? Loading03Icon : RotateClockwiseIcon}
            size={14}
            className={pending ? "animate-spin" : undefined}
            data-icon="inline-start"
          />
          Refresh
        </Button>
      </div>
      <div className="mt-4">
        <HealthPanels health={health} />
      </div>
    </div>
  )
}
