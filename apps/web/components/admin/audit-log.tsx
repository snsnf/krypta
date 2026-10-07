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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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

const RESULTS: AdminAuditResult[] = ["succeeded", "rejected", "failed"]

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
  const actionItems: { value: AdminAuditAction | ""; label: string }[] = [
    { value: "", label: t("admin.audit.allActions") },
    ...ACTIONS.map((value) => ({
      value,
      label: t(`admin.audit.actions.${value}`),
    })),
  ]
  const resultItems: { value: AdminAuditResult | ""; label: string }[] = [
    { value: "", label: t("admin.audit.allResults") },
    ...RESULTS.map((value) => ({
      value,
      label: t(`admin.audit.results.${value}`),
    })),
  ]

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
          <Select
            items={actionItems}
            value={action}
            onValueChange={(next) => next !== null && setAction(next)}
            disabled={loading}
          >
            <SelectTrigger
              size="sm"
              aria-label={t("admin.audit.action")}
              className="text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actionItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={resultItems}
            value={result}
            onValueChange={(next) => next !== null && setResult(next)}
            disabled={loading}
          >
            <SelectTrigger
              size="sm"
              aria-label={t("admin.audit.result")}
              className="text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {resultItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
