"use client"

import { useCallback, useEffect, useState } from "react"
import { AccountList } from "@/components/admin/account-list"
import {
  listAdminAccounts,
  listEligibleOwnershipTransfers,
  type AdminAccount,
  type AdminCursor,
  type EligibleOwnershipTransfer,
} from "@/lib/admin"

async function loadEligibleTransfers(
  accounts: AdminAccount[]
): Promise<Record<string, EligibleOwnershipTransfer[]>> {
  const entries = await Promise.all(
    accounts.map(async (account) => {
      try {
        return [
          account.id,
          await listEligibleOwnershipTransfers(account.id),
        ] as const
      } catch {
        return [account.id, []] as const
      }
    })
  )
  return Object.fromEntries(entries)
}

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [nextCursor, setNextCursor] = useState<AdminCursor | null>(null)
  const [eligibleTransfersByAccount, setEligibleTransfersByAccount] = useState<
    Record<string, EligibleOwnershipTransfer[]>
  >({})
  const [search, setSearch] = useState("")
  const [reloadIndex, setReloadIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const loadMore = useCallback(
    (cursor: AdminCursor | null) => {
      setLoading(true)
      setError(false)
      void listAdminAccounts({ search, cursor }).then(
        async (page) => {
          setAccounts((current) => [...current, ...page.accounts])
          setNextCursor(page.nextCursor)
          const transfers = await loadEligibleTransfers(page.accounts)
          setEligibleTransfersByAccount((current) => ({
            ...current,
            ...transfers,
          }))
          setLoading(false)
        },
        () => {
          setError(true)
          setLoading(false)
        }
      )
    },
    [search]
  )

  useEffect(() => {
    let cancelled = false
    void listAdminAccounts({ search }).then(
      async (page) => {
        if (cancelled) return
        setAccounts(page.accounts)
        setNextCursor(page.nextCursor)
        const transfers = await loadEligibleTransfers(page.accounts)
        if (cancelled) return
        setEligibleTransfersByAccount(transfers)
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
  }, [reloadIndex, search])

  function applySearch(value: string): void {
    setLoading(true)
    setSearch(value)
  }

  function refresh(): void {
    setLoading(true)
    setReloadIndex((current) => current + 1)
  }

  return (
    <AccountList
      accounts={accounts}
      nextCursor={nextCursor}
      loading={loading}
      error={error}
      eligibleTransfersByAccount={eligibleTransfersByAccount}
      onSearch={applySearch}
      onLoadMore={() => loadMore(nextCursor)}
      onRefresh={refresh}
    />
  )
}
