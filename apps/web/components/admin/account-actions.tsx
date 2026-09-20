"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Delete02Icon,
  ShieldKeyIcon,
  UserCheck01Icon,
  UserSwitchIcon,
  UserBlock01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/toast"
import {
  deleteAccount,
  reactivateAccount,
  suspendAccount,
  transferAdminForm,
  type AdminAccount,
} from "@/lib/admin"
import { ApiClientError, apiFetch } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { deriveAuthVerifier } from "@krypta/crypto"
import { deriveVaultUnlockKey } from "@/lib/vault-access"

interface EligibleTransfer {
  formId: string
  editorMemberIds: string[]
}

interface TransferSelection {
  formId: string
  editorMemberId: string
}

export function reconcileEligibleTransferSelection(
  eligibleTransfers: EligibleTransfer[],
  current: TransferSelection
): TransferSelection {
  const currentTransfer = eligibleTransfers.find(
    (transfer) => transfer.formId === current.formId
  )
  if (currentTransfer?.editorMemberIds.includes(current.editorMemberId)) {
    return current
  }

  const nextTransfer = eligibleTransfers.find(
    (transfer) => transfer.editorMemberIds.length > 0
  )
  return {
    formId: nextTransfer?.formId ?? "",
    editorMemberId: nextTransfer?.editorMemberIds[0] ?? "",
  }
}

interface AccountActionsProps {
  account: AdminAccount
  eligibleTransfers?: EligibleTransfer[]
  onChanged: () => void
}

function genericError(): void {
  toast.add({
    title: "Could not update account",
    description: "Try again.",
    type: "error",
  })
}

export function resetDeleteProofAfterFailure(): {
  receipt: null
  confirmation: string
} {
  return { receipt: null, confirmation: "" }
}

export function AccountActions({
  account,
  eligibleTransfers = [],
  onChanged,
}: AccountActionsProps) {
  const [suspendOpen, setSuspendOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pending, setPending] = useState<
    "suspend" | "delete" | "transfer" | null
  >(null)
  const [password, setPassword] = useState("")
  const [receipt, setReceipt] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState("")
  const [transferSelection, setTransferSelection] = useState<TransferSelection>(
    () =>
      reconcileEligibleTransferSelection(eligibleTransfers, {
        formId: "",
        editorMemberId: "",
      })
  )
  const reconciledTransferSelection = reconcileEligibleTransferSelection(
    eligibleTransfers,
    transferSelection
  )
  const selectedFormId = reconciledTransferSelection.formId
  const selectedTransfer = eligibleTransfers.find(
    (transfer) => transfer.formId === selectedFormId
  )
  const selectedEditorMemberId = reconciledTransferSelection.editorMemberId
  const accountSuffix = account.id.slice(-8)

  async function changeSuspension(): Promise<void> {
    setPending("suspend")
    try {
      if (account.suspended) await reactivateAccount(account.id)
      else await suspendAccount(account.id)
      setSuspendOpen(false)
      toast.add({
        title: account.suspended ? "Account reactivated" : "Account suspended",
        type: "success",
      })
      onChanged()
    } catch {
      genericError()
    } finally {
      setPending(null)
    }
  }

  async function provePassword(): Promise<void> {
    setPending("delete")
    try {
      // The server authenticates the verifier, never the password, so the
      // admin's own address is what the derivation salt comes from.
      const email = useAuthStore.getState().email
      if (email === null) throw new Error("no authenticated session")
      const verifier = deriveAuthVerifier(
        await deriveVaultUnlockKey(email, password)
      )
      const proof = await apiFetch<{ reauthentication_receipt: string }>(
        "/auth/reauthenticate",
        { method: "POST", body: JSON.stringify({ verifier }) }
      )
      setPassword("")
      setReceipt(proof.reauthentication_receipt)
    } catch {
      toast.add({
        title: "Could not verify password",
        description: "Try again.",
        type: "error",
      })
    } finally {
      setPending(null)
    }
  }

  async function confirmDeletion(): Promise<void> {
    if (receipt === null || confirmation !== accountSuffix) return
    setPending("delete")
    try {
      await deleteAccount(account.id, receipt)
      setDeleteOpen(false)
      setReceipt(null)
      setConfirmation("")
      toast.add({ title: "Account deleted", type: "success" })
      onChanged()
    } catch (error) {
      const reset = resetDeleteProofAfterFailure()
      setReceipt(reset.receipt)
      setConfirmation(reset.confirmation)
      // Deleting the account cannot cancel anything at Stripe, so the server
      // refuses while the account is still being billed. Only the account
      // holder can cancel, from their own billing settings.
      if (
        error instanceof ApiClientError &&
        error.code === "active_subscription"
      ) {
        toast.add({
          title: "This account has an active subscription",
          description:
            "The account holder has to cancel it from their billing settings before the account can be deleted.",
          type: "error",
        })
        return
      }
      toast.add({
        title: "Verify password again",
        description: "The deletion could not be completed. Try again.",
        type: "error",
      })
    } finally {
      setPending(null)
    }
  }

  async function transfer(): Promise<void> {
    if (!selectedFormId || !selectedEditorMemberId) return
    setPending("transfer")
    try {
      await transferAdminForm(selectedFormId, selectedEditorMemberId)
      toast.add({ title: "Form ownership transferred", type: "success" })
      onChanged()
    } catch {
      toast.add({
        title: "Could not transfer ownership",
        description: "Try again.",
        type: "error",
      })
    } finally {
      setPending(null)
    }
  }

  function resetDeletion(open: boolean): void {
    setDeleteOpen(open)
    if (!open) {
      setPassword("")
      setReceipt(null)
      setConfirmation("")
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dialog open={suspendOpen} onOpenChange={setSuspendOpen}>
        <Button
          variant={account.suspended ? "outline" : "secondary"}
          size="sm"
          onClick={() => setSuspendOpen(true)}
          disabled={pending !== null}
        >
          <HugeiconsIcon
            icon={account.suspended ? UserCheck01Icon : UserBlock01Icon}
            size={14}
            data-icon="inline-start"
          />
          {account.suspended ? "Reactivate" : "Suspend"}
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {account.suspended ? "Reactivate account?" : "Suspend account?"}
            </DialogTitle>
            <DialogDescription>
              {account.suspended
                ? "The account can sign in again, but its prior sessions remain revoked."
                : "This ends the account’s sessions and blocks new sign-ins and owned-form submissions."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </DialogClose>
            <Button
              variant={account.suspended ? "default" : "destructive"}
              size="sm"
              disabled={pending !== null}
              onClick={changeSuspension}
            >
              {pending !== "suspend" && (
                <HugeiconsIcon
                  icon={account.suspended ? UserCheck01Icon : UserBlock01Icon}
                  size={14}
                  data-icon="inline-start"
                />
              )}
              {pending === "suspend"
                ? "Saving..."
                : account.suspended
                  ? "Reactivate account"
                  : "Suspend account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {eligibleTransfers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`transfer-form-${account.id}`}>
            Shared form
          </label>
          <select
            id={`transfer-form-${account.id}`}
            value={selectedFormId}
            onChange={(event) => {
              const formId = event.target.value
              const editorMemberId = eligibleTransfers.find(
                (transfer) => transfer.formId === formId
              )?.editorMemberIds[0]
              setTransferSelection({
                formId,
                editorMemberId: editorMemberId ?? "",
              })
            }}
            className="h-7 max-w-36 rounded-lg border border-input bg-transparent px-2 text-xs"
            disabled={pending !== null}
          >
            {eligibleTransfers.map((transfer) => (
              <option key={transfer.formId} value={transfer.formId}>
                {transfer.formId}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`transfer-editor-${account.id}`}>
            Eligible editor
          </label>
          <select
            id={`transfer-editor-${account.id}`}
            value={selectedEditorMemberId}
            onChange={(event) =>
              setTransferSelection((current) => ({
                ...current,
                editorMemberId: event.target.value,
              }))
            }
            className="h-7 max-w-36 rounded-lg border border-input bg-transparent px-2 text-xs"
            disabled={
              pending !== null || !selectedTransfer?.editorMemberIds.length
            }
          >
            {selectedTransfer?.editorMemberIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={pending !== null || !selectedEditorMemberId}
            onClick={transfer}
          >
            {pending !== "transfer" && (
              <HugeiconsIcon
                icon={UserSwitchIcon}
                size={14}
                data-icon="inline-start"
              />
            )}
            {pending === "transfer" ? "Transferring..." : "Transfer"}
          </Button>
        </div>
      )}

      <Dialog open={deleteOpen} onOpenChange={resetDeletion}>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDeleteOpen(true)}
          disabled={pending !== null}
        >
          <HugeiconsIcon
            icon={Delete02Icon}
            size={14}
            data-icon="inline-start"
          />
          Delete
        </Button>
        <DialogContent>
          {receipt === null ? (
            <>
              <DialogHeader>
                <DialogTitle>Verify before deleting</DialogTitle>
                <DialogDescription>
                  Deleting this account is irreversible. First verify your
                  password; the confirmation step follows immediately.
                </DialogDescription>
              </DialogHeader>
              <label className="grid gap-1.5 text-sm font-medium">
                Password
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  disabled={pending !== null}
                />
              </label>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" size="sm" />}>
                  Cancel
                </DialogClose>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending !== null || password.length === 0}
                  onClick={provePassword}
                >
                  {pending !== "delete" && (
                    <HugeiconsIcon
                      icon={ShieldKeyIcon}
                      size={14}
                      data-icon="inline-start"
                    />
                  )}
                  {pending === "delete" ? "Verifying..." : "Continue"}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Delete account permanently?</DialogTitle>
                <DialogDescription>
                  Type the visible account suffix <code>{accountSuffix}</code>{" "}
                  to permanently delete this account and its unshared encrypted
                  records.
                </DialogDescription>
              </DialogHeader>
              <label className="grid gap-1.5 text-sm font-medium">
                Account suffix
                <Input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending !== null}
                />
              </label>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" size="sm" />}>
                  Cancel
                </DialogClose>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending !== null || confirmation !== accountSuffix}
                  onClick={confirmDeletion}
                >
                  {pending !== "delete" && (
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      size={14}
                      data-icon="inline-start"
                    />
                  )}
                  {pending === "delete" ? "Deleting..." : "Delete account"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
