"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  RotateClockwiseIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { useAppFormat, useAppT } from "@/lib/app-i18n"
import { AccountActions } from "@/components/admin/account-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  type AdminAccount,
  type AdminCursor,
  type EligibleOwnershipTransfer,
} from "@/lib/admin"

interface AccountListProps {
  accounts: AdminAccount[]
  nextCursor: AdminCursor | null
  loading: boolean
  error: boolean
  eligibleTransfersByAccount: Record<string, EligibleOwnershipTransfer[]>
  onSearch: (search: string) => void
  onLoadMore: () => void
  onRefresh: () => void
}

export function AccountList({
  accounts,
  nextCursor,
  loading,
  error,
  eligibleTransfersByAccount,
  onSearch,
  onLoadMore,
  onRefresh,
}: AccountListProps) {
  const t = useAppT()
  const format = useAppFormat()

  const [search, setSearch] = useState("")

  return (
    <section>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            {t("admin.accounts.title")}
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t("admin.accounts.body")}
          </p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            onSearch(search)
          }}
        >
          <label className="sr-only" htmlFor="account-search">
            {t("admin.accounts.searchLabel")}
          </label>
          <Input
            id="account-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            dir="ltr"
            placeholder={t("admin.accounts.searchPlaceholder")}
            className="w-48"
          />
          <Button type="submit" disabled={loading}>
            <HugeiconsIcon
              icon={Search01Icon}
              size={15}
              data-icon="inline-start"
            />
            {t("admin.accounts.search")}
          </Button>
        </form>
      </div>

      {error ? (
        <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium">
            {t("admin.accounts.loadFailed")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("admin.accounts.tryAgain")}
          </p>
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
      ) : loading && accounts.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          {t("admin.accounts.loadingAccounts")}
        </p>
      ) : accounts.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          {t("admin.accounts.none")}
        </p>
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-border">
          <div className="divide-y divide-border">
            {accounts.map((account) => (
              <article
                key={account.id}
                className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <code
                    dir="ltr"
                    className="block truncate text-start text-sm text-foreground"
                  >
                    {account.id}
                  </code>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {account.suspended
                        ? t("admin.accounts.suspended")
                        : t("admin.accounts.active")}
                    </span>
                    <span>
                      {account.totpEnabled
                        ? t("admin.accounts.totpOn")
                        : t("admin.accounts.totpOff")}
                    </span>
                    {account.instanceAdmin && (
                      <span>{t("admin.accounts.instanceAdmin")}</span>
                    )}
                    <span>
                      {t("admin.accounts.created", {
                        date: format.date(account.createdAt),
                      })}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("admin.accounts.usage", {
                      used: account.formsUsed,
                      max: account.maxForms ?? t("admin.accounts.default"),
                      bytes: format.bytes(account.attachmentBytesUsed),
                      maxBytes:
                        account.maxAttachmentBytes === null
                          ? t("admin.accounts.default")
                          : format.bytes(account.maxAttachmentBytes),
                    })}
                  </p>
                </div>
                <AccountActions
                  account={account}
                  eligibleTransfers={eligibleTransfersByAccount[account.id]}
                  onChanged={onRefresh}
                />
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
          onClick={onLoadMore}
          disabled={loading}
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
