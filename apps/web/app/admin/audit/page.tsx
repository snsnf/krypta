"use client"

import { useCallback, useEffect, useState } from "react"
import { AuditLog } from "@/components/admin/audit-log"
import {
  listAuditEvents,
  type AdminAuditAction,
  type AdminAuditEvent,
  type AdminAuditResult,
  type AdminCursor,
} from "@/lib/admin"

export default function AdminAuditPage() {
  const [events, setEvents] = useState<AdminAuditEvent[]>([])
  const [nextCursor, setNextCursor] = useState<AdminCursor | null>(null)
  const [filters, setFilters] = useState<{
    action?: AdminAuditAction
    result?: AdminAuditResult
  }>({})
  const [reloadIndex, setReloadIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const loadMore = useCallback(
    (cursor: AdminCursor | null) => {
      setLoading(true)
      setError(false)
      void listAuditEvents({ ...filters, cursor }).then(
        (page) => {
          setEvents((current) => [...current, ...page.events])
          setNextCursor(page.nextCursor)
          setLoading(false)
        },
        () => {
          setError(true)
          setLoading(false)
        }
      )
    },
    [filters]
  )

  useEffect(() => {
    let cancelled = false
    void listAuditEvents(filters).then(
      (page) => {
        if (cancelled) return
        setEvents(page.events)
        setNextCursor(page.nextCursor)
        setError(false)
        setLoading(false)
      },
      () => {
        if (cancelled) return
        setError(true)
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [filters, reloadIndex])

  function applyFilters(nextFilters: {
    action?: AdminAuditAction
    result?: AdminAuditResult
  }): void {
    setLoading(true)
    setFilters(nextFilters)
  }

  function refresh(): void {
    setLoading(true)
    setReloadIndex((current) => current + 1)
  }

  return (
    <AuditLog
      events={events}
      nextCursor={nextCursor}
      loading={loading}
      error={error}
      onFilter={applyFilters}
      onLoadMore={() => loadMore(nextCursor)}
      onRefresh={refresh}
    />
  )
}
