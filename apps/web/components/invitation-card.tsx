import Link from "next/link"
import type { InvitationViewState } from "../lib/invitation-flow"
import { Button } from "./ui/button"

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
  if (view.kind === "exchanging" || view.kind === "accepting") {
    return (
      <div role="status">
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          {view.kind === "exchanging"
            ? "Checking invitation"
            : "Updating invitation"}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This should only take a moment.
        </p>
      </div>
    )
  }

  if (view.kind === "signed_out") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            Sign in to continue
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Your invitation is held securely while you sign in or create an
            account.
          </p>
        </div>
        <Button
          render={<Link href={`/login?${invitationReturnQuery}`} />}
          nativeButton={false}
        >
          Log in
        </Button>
        <Button
          variant="outline"
          render={<Link href={`/signup?${invitationReturnQuery}`} />}
          nativeButton={false}
        >
          Create an account
        </Button>
      </div>
    )
  }

  if (view.kind === "ready") {
    const role = view.role === "editor" ? "an editor" : "a viewer"
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            Form invitation
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            You&apos;ve been invited to collaborate as {role}.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <p className="text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Invited account
          </p>
          <p className="mt-1 text-sm font-medium">{view.maskedEmail}</p>
        </div>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onAccept}>
            Accept
          </Button>
          <Button className="flex-1" variant="outline" onClick={onDecline}>
            Decline
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
            Invitation accepted
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            No further approval is needed. Secure access is being prepared and
            will appear on your dashboard when it is ready.
          </p>
        </div>
        <Button render={<Link href="/dashboard" />} nativeButton={false}>
          Go to dashboard
        </Button>
      </div>
    )
  }

  if (view.kind === "active") {
    return (
      <div role="status">
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          Invitation accepted
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Opening the shared form…
        </p>
      </div>
    )
  }

  if (view.kind === "wrong_account") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
            Use the invited account
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            This invitation belongs to a different account. Switch accounts to
            continue without changing the invitation.
          </p>
        </div>
        <Button onClick={onSwitchAccount} disabled={switchingAccount}>
          {switchingAccount ? "Signing out…" : "Sign out and switch account"}
        </Button>
        <p aria-live="polite" className="text-sm text-destructive">
          {switchAccountError}
        </p>
        <Button
          variant="outline"
          render={<Link href="/dashboard" />}
          nativeButton={false}
        >
          Back to dashboard
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          Invitation unavailable
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This invitation is invalid, expired, revoked, or has already been
          used.
        </p>
      </div>
      <Button
        variant="outline"
        render={<Link href="/dashboard" />}
        nativeButton={false}
      >
        Go to dashboard
      </Button>
    </div>
  )
}
