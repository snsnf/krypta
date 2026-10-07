"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  FilterHorizontalIcon,
  RotateClockwiseIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { translateKey, useAppFormat, useAppT } from "@/lib/app-i18n"
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

const ACTIONS: AdminAuditAction[] = [
  "settings_updated",
  "account_suspended",
  "account_reactivated",
  "form_transferred",
  "account_deletion_started",
  "account_deleted",
]

export function AuditLog({
  events,
  nextCursor,
  loading,
  error,
  onFilter,
  onLoadMore,
  onRefresh,
}: AuditLogProps) {
  const t = useAppT()
  const format = useAppFormat()

  const [action, setAction] = useState<AdminAuditAction | "">("")
  const [result, setResult] = useState<AdminAuditResult | "">("")

  return (
    <section>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            {t("admin.audit.title")}
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t("admin.audit.body")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="audit-action">
            {t("admin.audit.action")}
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
            <option value="">{t("admin.audit.allActions")}</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`admin.audit.actions.${value}`)}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="audit-result">
            {t("admin.audit.result")}
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
            <option value="">{t("admin.audit.allResults")}</option>
            <option value="succeeded">
              {t("admin.audit.results.succeeded")}
            </option>
            <option value="rejected">
              {t("admin.audit.results.rejected")}
            </option>
            <option value="failed">{t("admin.audit.results.failed")}</option>
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
            {t("admin.audit.apply")}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium">{t("admin.audit.loadFailed")}</p>
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
            {t("common.retry")}
          </Button>
        </div>
      ) : loading && events.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          {t("admin.audit.loadingEvents")}
        </p>
      ) : events.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          {t("admin.audit.none")}
        </p>
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-border">
          <div className="divide-y divide-border">
            {events.map((event) => (
              <article key={event.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {t(`admin.audit.actions.${event.action}`)}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {translateKey(t, `admin.audit.results.${event.result}`)}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t.rich("admin.audit.actor", {
                    id: event.actorUserId,
                    code: (chunks) => <code dir="ltr">{chunks}</code>,
                  })}
                  {event.targetUserId && (
                    <>
                      {" · "}
                      {t.rich("admin.audit.target", {
                        id: event.targetUserId,
                        code: (chunks) => <code dir="ltr">{chunks}</code>,
                      })}
                    </>
                  )}
                  {" · "}
                  {format.date(event.createdAt, true)}
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
          {loading ? t("admin.common.loading") : t("admin.common.loadMore")}
        </Button>
      )}
    </section>
  )
}
