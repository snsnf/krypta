"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  RotateClockwiseIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  const [search, setSearch] = useState("")

  return (
    <section>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            Accounts
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Account metadata, usage quotas, and access state. Encrypted form
            content is never available here.
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
            Search by account ID
          </label>
          <Input
            id="account-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Account ID"
            className="w-48"
          />
          <Button type="submit" disabled={loading}>
            <HugeiconsIcon
              icon={Search01Icon}
              size={15}
              data-icon="inline-start"
            />
            Search
          </Button>
        </form>
      </div>

      {error ? (
        <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium">Could not load accounts</p>
          <p className="mt-1 text-sm text-muted-foreground">Try again.</p>
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
      ) : loading && accounts.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Loading accounts...
        </p>
      ) : accounts.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">No accounts found.</p>
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-border">
          <div className="divide-y divide-border">
            {accounts.map((account) => (
              <article
                key={account.id}
                className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <code className="block truncate text-sm text-foreground">
                    {account.id}
                  </code>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{account.suspended ? "Suspended" : "Active"}</span>
                    <span>
                      {account.totpEnabled ? "TOTP enabled" : "TOTP disabled"}
                    </span>
                    {account.instanceAdmin && <span>Instance admin</span>}
                    <span>
                      Created {new Date(account.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Forms {account.formsUsed} / {account.maxForms ?? "default"}{" "}
                    · Attachments {formatBytes(account.attachmentBytesUsed)} /{" "}
                    {account.maxAttachmentBytes === null
                      ? "default"
                      : formatBytes(account.maxAttachmentBytes)}
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
          {loading ? "Loading..." : "Load more"}
        </Button>
      )}
    </section>
  )
}
