"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  FilterHorizontalIcon,
  RotateClockwiseIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  type AdminAuditAction,
  type AdminAuditEvent,
  type AdminAuditResult,
  type AdminCursor,
} from "@/lib/admin"

interface AuditLogProps {
  events: AdminAuditEvent[]
  nextCursor: AdminCursor | null
  loading: boolean
  error: boolean
  onFilter: (filters: {
    action?: AdminAuditAction
    result?: AdminAuditResult
  }) => void
  onLoadMore: () => void
  onRefresh: () => void
}

const actionLabels: Record<AdminAuditAction, string> = {
  settings_updated: "Settings updated",
  account_suspended: "Account suspended",
  account_reactivated: "Account reactivated",
  form_transferred: "Form transferred",
  account_deletion_started: "Account deletion started",
  account_deleted: "Account deleted",
}

export function AuditLog({
  events,
  nextCursor,
  loading,
  error,
  onFilter,
  onLoadMore,
  onRefresh,
}: AuditLogProps) {
  const [action, setAction] = useState<AdminAuditAction | "">("")
  const [result, setResult] = useState<AdminAuditResult | "">("")

  return (
    <section>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            Audit log
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Administrative actions only. Events exclude content, email, IP,
            credentials, and deployment secrets.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="audit-action">
            Action
          </label>
          <select
            id="audit-action"
            value={action}
            onChange={(event) =>
              setAction(event.target.value as AdminAuditAction | "")
            }
            className="h-7 rounded-lg border border-input bg-transparent px-2 text-xs"
            disabled={loading}
          >
            <option value="">All actions</option>
            {Object.entries(actionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="audit-result">
            Result
          </label>
          <select
            id="audit-result"
            value={result}
            onChange={(event) =>
              setResult(event.target.value as AdminAuditResult | "")
            }
            className="h-7 rounded-lg border border-input bg-transparent px-2 text-xs"
            disabled={loading}
          >
            <option value="">All results</option>
            <option value="succeeded">Succeeded</option>
            <option value="rejected">Rejected</option>
            <option value="failed">Failed</option>
          </select>
          <Button
            size="sm"
            disabled={loading}
            onClick={() =>
              onFilter({
                action: action || undefined,
                result: result || undefined,
              })
            }
          >
            <HugeiconsIcon
              icon={FilterHorizontalIcon}
              size={14}
              data-icon="inline-start"
            />
            Apply
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium">Could not load audit events</p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={onRefresh}
          >
            <HugeiconsIcon
              icon={RotateClockwiseIcon}
              size={14}
              data-icon="inline-start"
            />
            Retry
          </Button>
        </div>
      ) : loading && events.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Loading audit events...
        </p>
      ) : events.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No audit events found.
        </p>
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-border">
          <div className="divide-y divide-border">
            {events.map((event) => (
              <article key={event.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {actionLabels[event.action]}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {event.result}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Actor <code>{event.actorUserId}</code>
                  {event.targetUserId && (
                    <>
                      {" · "}Target <code>{event.targetUserId}</code>
                    </>
                  )}
                  {" · "}
                  {new Date(event.createdAt).toLocaleString()}
                </p>
              </article>
            ))}
          </div>
        </div>
      )}

      {nextCursor !== null && (
        <Button
          className="mt-4"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={onLoadMore}
        >
          {!loading && (
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={14}
              data-icon="inline-start"
            />
          )}
          {loading ? "Loading..." : "Load more"}
        </Button>
      )}
    </section>
  )
}
