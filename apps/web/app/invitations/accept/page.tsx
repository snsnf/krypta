"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { formKeyPin } from "@krypta/crypto"
import { apiFetch } from "@/lib/api"
import { useAppT } from "@/lib/app-i18n"
import { ensureAccountSharingKey } from "@/lib/account-sharing-key"
import { useAuthStore, type UserBoundAccountKey } from "@/lib/auth-store"
import {
  createInvitationAccountSwitchProgress,
  switchInvitationAccount,
} from "@/lib/invitation-account-switch"
import {
  acceptanceViewState,
  currentInvitationViewState,
  forgetInvitationKey,
  invitationErrorViewState,
  recallInvitationKey,
  rememberInvitationKey,
  takeInvitationLink,
  type InvitationRole,
  type InvitationViewState,
} from "@/lib/invitation-flow"
import { ensureSodiumReady } from "@/lib/sodium-ready"
import { restoreVaultForDashboard } from "@/lib/vault-access"
import { AuthShell } from "@/components/auth-shell"
import { InvitationCard } from "@/components/invitation-card"

const invitationReturnQuery = "next=%2Finvitations%2Faccept"

interface CurrentInvitationResponse {
  role: InvitationRole
  status: "pending"
  masked_email: string
  grant_ready: boolean
}

interface AcceptanceResponse {
  form_id: string
  membership_state: "active" | "awaiting_keys"
}

function currentVault(): UserBoundAccountKey | null {
  const { userId, accountKey } = useAuthStore.getState()
  return userId === null || accountKey === null
    ? null
    : { expectedUserId: userId, accountKey }
}

function vaultStillCurrent(material: UserBoundAccountKey): boolean {
  const current = useAuthStore.getState()
  return (
    current.userId === material.expectedUserId &&
    current.accountKey === material.accountKey
  )
}

export default function InvitationAcceptancePage() {
  const router = useRouter()
  const t = useAppT()

  const [view, setView] = useState<InvitationViewState>({ kind: "exchanging" })
  const [switchingAccount, setSwitchingAccount] = useState(false)
  const [switchAccountError, setSwitchAccountError] = useState<string | null>(
    null
  )
  const decisionInFlight = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const invitationLoad = useRef<Promise<InvitationViewState> | null>(null)
  const accountSwitchProgress = useRef(createInvitationAccountSwitchProgress())

  useEffect(() => {
    let active = true

    invitationLoad.current ??= (async () => {
      try {
        const fragment = window.location.hash
        const link = takeInvitationLink(
          fragment,
          window.history.replaceState.bind(window.history)
        )

        if (fragment.length > 0 && link === null) {
          return { kind: "invalid" }
        }

        if (link !== null) {
          // Kept before anything can navigate away: signing in or unlocking
          // leaves this page, and the fragment does not come back with it.
          rememberInvitationKey(window.sessionStorage, link.key)
          await apiFetch<{ continued: true }>("/invitations/continue", {
            method: "POST",
            body: JSON.stringify({ token: link.token }),
          })
        }

        const invitation = await apiFetch<CurrentInvitationResponse>(
          "/invitations/current"
        )
        return currentInvitationViewState(invitation)
      } catch (error) {
        return invitationErrorViewState(error)
      }
    })()

    void invitationLoad.current.then((nextView) => {
      if (active) setView(nextView)
    })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    contentRef.current?.focus()
  }, [view.kind])

  async function prepareVault(): Promise<UserBoundAccountKey | null> {
    const available = currentVault()
    if (available !== null) {
      try {
        await ensureAccountSharingKey(available)
        if (vaultStillCurrent(available)) return available
        setView({ kind: "invalid" })
        return null
      } catch {
        router.replace(`/unlock?vault=retry&${invitationReturnQuery}`)
        return null
      }
    }

    const outcome = await restoreVaultForDashboard()
    if (outcome === "ready") return currentVault()
    if (outcome === "unlock" || outcome === "retry") {
      router.replace(
        outcome === "retry"
          ? `/unlock?vault=retry&${invitationReturnQuery}`
          : `/unlock?${invitationReturnQuery}`
      )
    } else if (outcome === "stale") {
      setView({ kind: "invalid" })
    }
    return null
  }

  async function handleDecision(accept: boolean) {
    if (decisionInFlight.current || view.kind !== "ready") return
    decisionInFlight.current = true
    const role = view.role
    setView({ kind: "accepting", role })

    try {
      if (!accept) {
        await apiFetch<Record<string, never>>("/invitations/current/decline", {
          method: "POST",
        })
        forgetInvitationKey(window.sessionStorage)
        router.replace("/dashboard")
        return
      }

      // The fingerprint from the emailed link is what this member's browser
      // will hold the form's key to from now on. Without one there is nothing
      // to pin, and accepting anyway would leave a membership whose keys this
      // browser refuses to open, so the link is treated as unusable.
      const invitationKey = recallInvitationKey(window.sessionStorage)
      if (invitationKey === null) {
        setView({ kind: "invalid" })
        return
      }

      const vault = await prepareVault()
      if (vault === null) return

      await ensureSodiumReady()
      const response = await apiFetch<AcceptanceResponse>(
        "/invitations/current/accept",
        {
          method: "POST",
          body: JSON.stringify({
            key_pin: formKeyPin(
              vault.accountKey,
              invitationKey.formId,
              invitationKey.keyFingerprint
            ),
          }),
        }
      )
      forgetInvitationKey(window.sessionStorage)
      const accepted = acceptanceViewState(response)

      if (accepted.kind === "awaiting_keys") {
        setView(accepted)
        return
      }
      if (accepted.kind !== "active" || !vaultStillCurrent(vault)) {
        setView({ kind: "invalid" })
        return
      }

      await ensureAccountSharingKey(vault)
      if (!vaultStillCurrent(vault)) {
        setView({ kind: "invalid" })
        return
      }

      setView(accepted)
      router.replace(`/dashboard/${accepted.formId}`)
    } catch (error) {
      setView(invitationErrorViewState(error))
    } finally {
      decisionInFlight.current = false
    }
  }

  async function switchAccount() {
    if (switchingAccount) return
    setSwitchingAccount(true)
    setSwitchAccountError(null)
    const result = await switchInvitationAccount(
      accountSwitchProgress.current,
      (destination) => router.replace(destination)
    )
    if (result === "failed") {
      setSwitchAccountError(t("invitation.switchFailed"))
    }
    setSwitchingAccount(false)
  }

  return (
    <AuthShell>
      <div ref={contentRef} tabIndex={-1} className="outline-none">
        <InvitationCard
          view={view}
          switchingAccount={switchingAccount}
          switchAccountError={switchAccountError}
          onAccept={() => void handleDecision(true)}
          onDecline={() => void handleDecision(false)}
          onSwitchAccount={() => void switchAccount()}
        />
      </div>
    </AuthShell>
  )
}
