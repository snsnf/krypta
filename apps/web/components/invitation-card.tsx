import Link from "next/link"
import type { InvitationViewState } from "../lib/invitation-flow"
import { Button } from "./ui/button"
import { useAppT } from "../lib/app-i18n"

const invitationReturnQuery = "next=%2Finvitations%2Faccept"

export function InvitationCard({
  view,
  switchingAccount,
  switchAccountError,
  onAccept,
  onDecline,
  onSwitchAccount,
}: {
  view: InvitationViewState
  switchingAccount: boolean
  switchAccountError: string | null
  onAccept: () => void
  onDecline: () => void
  onSwitchAccount: () => void
}) {
  const t = useAppT()
  if (view.kind === "exchanging" || view.kind === "accepting") {
    return (
      <div role="status">
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          {view.kind === "exchanging"
            ? t("invitation.checking")
            : t("invitation.updating")}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("invitation.moment")}
        </p>
      </div>
    )
  }

  if (view.kind === "signed_out") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            {t("invitation.signInTitle")}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("invitation.signInBody")}
          </p>
        </div>
        <Button
          render={<Link href={`/login?${invitationReturnQuery}`} />}
          nativeButton={false}
        >
          {t("invitation.logIn")}
        </Button>
        <Button
          variant="outline"
          render={<Link href={`/signup?${invitationReturnQuery}`} />}
          nativeButton={false}
        >
          {t("invitation.createAccount")}
        </Button>
      </div>
    )
  }

  if (view.kind === "ready") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            {t("invitation.readyTitle")}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {view.role === "editor"
              ? t("invitation.asEditor")
              : t("invitation.asViewer")}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <p className="text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
            {t("invitation.invitedAccount")}
          </p>
          <p dir="ltr" className="mt-1 text-start text-sm font-medium">
            {view.maskedEmail}
          </p>
        </div>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onAccept}>
            {t("invitation.accept")}
          </Button>
          <Button className="flex-1" variant="outline" onClick={onDecline}>
            {t("invitation.decline")}
          </Button>
        </div>
      </div>
    )
  }

  if (view.kind === "awaiting_keys") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            {t("invitation.acceptedTitle")}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("invitation.awaiting")}
          </p>
        </div>
        <Button render={<Link href="/dashboard" />} nativeButton={false}>
          {t("invitation.toDashboard")}
        </Button>
      </div>
    )
  }

  if (view.kind === "active") {
    return (
      <div role="status">
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          {t("invitation.acceptedTitle")}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("invitation.opening")}
        </p>
      </div>
    )
  }

  if (view.kind === "wrong_account") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            {t("invitation.wrongTitle")}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("invitation.wrongBody")}
          </p>
        </div>
        <Button onClick={onSwitchAccount} disabled={switchingAccount}>
          {switchingAccount
            ? t("invitation.signingOut")
            : t("invitation.switch")}
        </Button>
        <p aria-live="polite" className="text-sm text-destructive">
          {switchAccountError}
        </p>
        <Button
          variant="outline"
          render={<Link href="/dashboard" />}
          nativeButton={false}
        >
          {t("invitation.backToDashboard")}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          {t("invitation.unavailableTitle")}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("invitation.unavailableBody")}
        </p>
      </div>
      <Button
        variant="outline"
        render={<Link href="/dashboard" />}
        nativeButton={false}
      >
        {t("invitation.toDashboard")}
      </Button>
    </div>
  )
}
