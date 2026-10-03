"use client"

import { useRef, useState, type FormEvent, type RefObject } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  RotateClockwiseIcon,
  Share01Icon,
  UserAdd01Icon,
  UserRemove01Icon,
  UserSwitchIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "@/components/ui/toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ApiClientError, apiFetch } from "@/lib/api"
import { memberControls, transferOwnership } from "@/lib/sharing-controls"
import { sendInvitation } from "@/lib/sharing-invitations"
import { useAppFormat, useAppT } from "@/lib/app-i18n"

type MemberRole = "owner" | "editor" | "viewer"
type CollaboratorRole = Exclude<MemberRole, "owner">

interface CollaborationMember {
  id: string
  email: string
  role: MemberRole
  state: "active" | "awaiting_keys"
  created_at: string
  updated_at: string
}

interface CollaborationInvitation {
  id: string
  invited_email: string
  role: CollaboratorRole
  status: "sending" | "pending" | "delivery_failed"
  expires_at: string | null
  created_at: string
  updated_at: string
}

interface CollaborationData {
  members: CollaborationMember[]
  invitations: CollaborationInvitation[]
}

type Confirmation =
  | {
      kind: "remove"
      id: string
      email: string
    }
  | {
      kind: "revoke"
      id: string
      email: string
    }
  | {
      kind: "transfer"
      id: string
      email: string
    }

interface SharingDialogProps {
  formId: string
  formDataKey: string
  formPrivateKey: string
  onOwnershipTransferred: () => void
}

const pressFeedback =
  "transition-transform duration-150 ease-out active:translate-y-0 active:scale-[0.97]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMemberRole(value: unknown): value is MemberRole {
  return value === "owner" || value === "editor" || value === "viewer"
}

function isCollaboratorRole(value: unknown): value is CollaboratorRole {
  return value === "editor" || value === "viewer"
}

function parseCollaboration(value: unknown): CollaborationData {
  if (
    !isRecord(value) ||
    !Array.isArray(value.members) ||
    !Array.isArray(value.invitations)
  ) {
    throw new Error("Invalid collaboration response")
  }

  const members = value.members.map((member): CollaborationMember => {
    if (
      !isRecord(member) ||
      typeof member.id !== "string" ||
      typeof member.email !== "string" ||
      !isMemberRole(member.role) ||
      (member.state !== "active" && member.state !== "awaiting_keys") ||
      typeof member.created_at !== "string" ||
      typeof member.updated_at !== "string"
    ) {
      throw new Error("Invalid collaboration response")
    }
    return member as unknown as CollaborationMember
  })

  const invitations = value.invitations.map(
    (invitation): CollaborationInvitation => {
      if (
        !isRecord(invitation) ||
        typeof invitation.id !== "string" ||
        typeof invitation.invited_email !== "string" ||
        !isCollaboratorRole(invitation.role) ||
        (invitation.status !== "sending" &&
          invitation.status !== "pending" &&
          invitation.status !== "delivery_failed") ||
        (invitation.expires_at !== null &&
          typeof invitation.expires_at !== "string") ||
        typeof invitation.created_at !== "string" ||
        typeof invitation.updated_at !== "string"
      ) {
        throw new Error("Invalid collaboration response")
      }
      return invitation as unknown as CollaborationInvitation
    }
  )

  return { members, invitations }
}

function RoleSelect({
  value,
  label,
  disabled,
  onChange,
}: {
  value: CollaboratorRole
  label: string
  disabled: boolean
  onChange: (role: CollaboratorRole) => void
}) {
  const t = useAppT()
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as CollaboratorRole)}
        className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="editor">{t("roles.editor")}</option>
        <option value="viewer">{t("roles.viewer")}</option>
      </select>
    </label>
  )
}

function ConfirmationDialog({
  confirmation,
  open,
  busy,
  cancelRef,
  onOpenChange,
  onConfirm,
}: {
  confirmation: Confirmation | null
  open: boolean
  busy: boolean
  cancelRef: RefObject<HTMLButtonElement | null>
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const t = useAppT()
  if (confirmation === null) return null

  const content =
    confirmation.kind === "transfer"
      ? {
          title: t("sharing.transferTitle"),
          description: t("sharing.transferBody", { email: confirmation.email }),
          action: t("sharing.transferAction"),
          destructive: false,
          icon: UserSwitchIcon,
        }
      : confirmation.kind === "remove"
        ? {
            title: t("sharing.removeTitle"),
            description: t("sharing.removeBody", { email: confirmation.email }),
            action: t("common.remove"),
            destructive: true,
            icon: UserRemove01Icon,
          }
        : {
            title: t("sharing.revokeTitle"),
            description: t("sharing.revokeBody", { email: confirmation.email }),
            action: t("sharing.revoke"),
            destructive: true,
            icon: Cancel01Icon,
          }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sharing-dialog-surface sm:max-w-md"
        overlayClassName="sharing-dialog-overlay"
        showCloseButton={false}
        initialFocus={cancelRef}
      >
        <DialogHeader className="text-center sm:text-start">
          <DialogTitle>{content.title}</DialogTitle>
          <DialogDescription>{content.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant={content.destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={onConfirm}
            className={pressFeedback}
          >
            {!busy && (
              <HugeiconsIcon
                icon={content.icon}
                size={14}
                data-icon="inline-start"
              />
            )}
            {busy ? t("sharing.working") : content.action}
          </Button>
          <DialogClose
            render={
              <Button
                ref={cancelRef}
                variant="outline"
                disabled={busy}
                className={pressFeedback}
              />
            }
          >
            {t("common.cancel")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SharingDialog({
  formId,
  formDataKey,
  formPrivateKey,
  onOwnershipTransferred,
}: SharingDialogProps) {
  const t = useAppT()
  const format = useAppFormat()
  const roleLabel = (role: MemberRole) => t(`roles.${role}`)
  const genericFailure = t("sharing.genericFailure")

  const [open, setOpen] = useState(false)
  const [collaboration, setCollaboration] = useState<CollaborationData | null>(
    null
  )
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<CollaboratorRole>("editor")
  const [feedback, setFeedback] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [busyActions, setBusyActions] = useState<Set<string>>(new Set())
  const busyActionsRef = useRef(new Set<string>())
  const ownerControlsActiveRef = useRef(true)
  const refreshSequenceRef = useRef(0)
  const cancelConfirmationRef = useRef<HTMLButtonElement>(null)

  const anyActionBusy = busyActions.size > 0

  function beginAction(key: string): boolean {
    if (!ownerControlsActiveRef.current || busyActionsRef.current.has(key)) {
      return false
    }
    busyActionsRef.current.add(key)
    setBusyActions(new Set(busyActionsRef.current))
    return true
  }

  function endAction(key: string): void {
    busyActionsRef.current.delete(key)
    setBusyActions(new Set(busyActionsRef.current))
  }

  function removeOwnerControls(): void {
    if (!ownerControlsActiveRef.current) return
    ownerControlsActiveRef.current = false
    refreshSequenceRef.current += 1
    setOpen(false)
    onOwnershipTransferred()
  }

  async function refreshCollaboration(showLoading = false): Promise<void> {
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    if (showLoading) setLoading(true)

    try {
      const raw = await apiFetch<unknown>(`/forms/${formId}/collaboration`)
      const next = parseCollaboration(raw)
      if (
        sequence === refreshSequenceRef.current &&
        ownerControlsActiveRef.current
      ) {
        setCollaboration(next)
        setFeedback(null)
      }
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "not_found") {
        removeOwnerControls()
      } else if (sequence === refreshSequenceRef.current) {
        setFeedback(genericFailure)
      }
      throw error
    } finally {
      if (sequence === refreshSequenceRef.current) setLoading(false)
    }
  }

  async function refreshAfterStaleFailure(error: unknown): Promise<void> {
    if (
      error instanceof ApiClientError &&
      (error.code === "not_found" || error.code === "conflict")
    ) {
      try {
        await refreshCollaboration()
      } catch {
        // The visible feedback and toast stay deliberately generic.
      }
    }
  }

  function reportFailure(): void {
    setFeedback(genericFailure)
    toast.add({
      title: t("sharing.updateFailed"),
      description: t("common.genericError"),
      type: "error",
    })
  }

  /**
   * Runs one guarded mutation: takes the latch, clears the banner, reports and
   * re-reads on failure, and always releases the latch.
   *
   * Every mutation below repeated those lines around its own few lines of
   * work, and a handler that threw before `endAction` left the dialog
   * permanently busy with no way back. There is now one place that can get
   * that wrong. The success sequence stays in each caller, because that is the
   * part that genuinely differs: what to clear, what to close, what to say.
   */
  async function runGuardedAction(
    actionKey: string,
    work: () => Promise<void>,
    onFailure?: () => void
  ): Promise<void> {
    if (!beginAction(actionKey)) return
    setFeedback(null)
    try {
      await work()
    } catch (error) {
      onFailure?.()
      reportFailure()
      await refreshAfterStaleFailure(error)
    } finally {
      endAction(actionKey)
    }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runGuardedAction("invite", async () => {
      await sendInvitation({
        formId,
        email,
        role,
        formDataKey,
        formPrivateKey,
      })
      await refreshCollaboration()
      setEmail("")
      toast.add({ title: t("sharing.invitationSent"), type: "success" })
    })
  }

  async function updateRole(
    member: CollaborationMember,
    next: CollaboratorRole
  ) {
    if (
      member.role === "owner" ||
      member.state !== "active" ||
      !isCollaboratorRole(next) ||
      next === member.role
    ) {
      return
    }
    await runGuardedAction(`role:${member.id}`, async () => {
      await apiFetch(`/forms/${formId}/members/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: next }),
      })
      await refreshCollaboration()
      toast.add({ title: t("sharing.roleUpdated"), type: "success" })
    })
  }

  async function resend(invitation: CollaborationInvitation) {
    await runGuardedAction(`resend:${invitation.id}`, async () => {
      await sendInvitation({
        formId,
        invitationId: invitation.id,
        email: invitation.invited_email,
        role: invitation.role,
        formDataKey,
        formPrivateKey,
      })
      await refreshCollaboration()
      toast.add({ title: t("sharing.invitationSent"), type: "success" })
    })
  }

  async function confirmAction() {
    if (confirmation === null) return
    const actionKey = `${confirmation.kind}:${confirmation.id}`

    if (confirmation.kind === "transfer") {
      // A transfer may not start while anything else is in flight: it ends
      // this caller's ownership, so a concurrent owner action would be
      // deciding against rights it is about to lose.
      if (busyActionsRef.current.size > 0) return
      await runGuardedAction(
        actionKey,
        async () => {
          ownerControlsActiveRef.current = false
          await transferOwnership(
            formId,
            confirmation.id,
            onOwnershipTransferred
          )
          refreshSequenceRef.current += 1
          setConfirmation(null)
          setOpen(false)
          toast.add({ title: t("sharing.transferred"), type: "success" })
        },
        () => {
          ownerControlsActiveRef.current = true
        }
      )
      return
    }

    await runGuardedAction(actionKey, async () => {
      const path =
        confirmation.kind === "remove"
          ? `/forms/${formId}/members/${confirmation.id}`
          : `/forms/${formId}/invitations/${confirmation.id}`
      await apiFetch(path, { method: "DELETE" })
      await refreshCollaboration()
      setConfirmation(null)
      toast.add({
        title:
          confirmation.kind === "remove"
            ? t("sharing.removed")
            : t("sharing.revoked"),
        type: "success",
      })
    })
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      setFeedback(null)
      void refreshCollaboration(true).catch(() => undefined)
    } else {
      setConfirmation(null)
    }
  }

  const activeMembers =
    collaboration?.members.filter((member) => member.state === "active") ?? []
  const awaitingMembers =
    collaboration?.members.filter(
      (member) => member.state === "awaiting_keys"
    ) ?? []

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={handleOpenChange}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen) setCollaboration(null)
        }}
      >
        <DialogTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              aria-label={t("sharing.share")}
              className={`${pressFeedback} max-sm:w-7 max-sm:px-0!`}
            />
          }
        >
          <HugeiconsIcon
            icon={Share01Icon}
            size={14}
            data-icon="inline-start"
          />
          <span className="hidden sm:inline">{t("sharing.share")}</span>
        </DialogTrigger>
        <DialogContent
          className="sharing-dialog-surface sm:max-w-2xl"
          overlayClassName="sharing-dialog-overlay"
        >
          <DialogHeader>
            <DialogTitle>{t("sharing.title")}</DialogTitle>
            <DialogDescription>{t("sharing.description")}</DialogDescription>
          </DialogHeader>

          <form
            onSubmit={handleInvite}
            className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end"
          >
            <label className="grid gap-1.5 text-sm font-medium">
              {t("sharing.emailLabel")}
              <input
                dir="ltr"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="collaborator@example.com"
                className="h-9 min-w-0 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {t("sharing.role")}
              <select
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as CollaboratorRole)
                }
                className="h-9 rounded-lg border border-input bg-background px-2 text-sm font-normal outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="editor">{t("roles.editor")}</option>
                <option value="viewer">{t("roles.viewer")}</option>
              </select>
            </label>
            <Button
              type="submit"
              disabled={busyActions.has("invite") || email.length === 0}
              className={pressFeedback}
            >
              {!busyActions.has("invite") && (
                <HugeiconsIcon
                  icon={UserAdd01Icon}
                  size={14}
                  data-icon="inline-start"
                />
              )}
              {busyActions.has("invite")
                ? t("sharing.sending")
                : t("sharing.invite")}
            </Button>
          </form>

          {feedback ? (
            <p
              role="status"
              aria-live="polite"
              className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {feedback}
            </p>
          ) : null}

          <div className="max-h-[min(28rem,55vh)] space-y-5 overflow-y-auto pe-1">
            {loading && collaboration === null ? (
              <p
                role="status"
                className="py-8 text-center text-sm text-muted-foreground"
              >
                {t("sharing.loading")}
              </p>
            ) : (
              <>
                <section aria-labelledby="active-collaborators-heading">
                  <h3
                    id="active-collaborators-heading"
                    className="mb-2 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase"
                  >
                    {t("sharing.activeHeading")}
                  </h3>
                  {activeMembers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("sharing.noActive")}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {activeMembers.map((member) => {
                        const roleAction = `role:${member.id}`
                        const controls = memberControls(member)
                        return (
                          <li
                            key={member.id}
                            className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0">
                              <p
                                dir="ltr"
                                className="text-start text-sm font-medium break-all"
                              >
                                {member.email}
                              </p>
                              {!controls.canChangeRole ? (
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {t("roles.owner")}
                                </p>
                              ) : null}
                            </div>
                            {!controls.canChangeRole ? (
                              <span className="w-fit rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                                {t("roles.owner")}
                              </span>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <RoleSelect
                                  value={member.role as CollaboratorRole}
                                  label={t("sharing.roleFor", {
                                    email: member.email,
                                  })}
                                  disabled={busyActions.has(roleAction)}
                                  onChange={(next) =>
                                    void updateRole(member, next)
                                  }
                                />
                                {controls.canTransfer ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={anyActionBusy}
                                    onClick={() =>
                                      setConfirmation({
                                        kind: "transfer",
                                        id: member.id,
                                        email: member.email,
                                      })
                                    }
                                    className={pressFeedback}
                                  >
                                    <HugeiconsIcon
                                      icon={UserSwitchIcon}
                                      size={14}
                                      data-icon="inline-start"
                                    />
                                    {t("sharing.transfer")}
                                  </Button>
                                ) : null}
                                {controls.canRemove ? (
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={busyActions.has(
                                      `remove:${member.id}`
                                    )}
                                    onClick={() =>
                                      setConfirmation({
                                        kind: "remove",
                                        id: member.id,
                                        email: member.email,
                                      })
                                    }
                                    className={pressFeedback}
                                  >
                                    <HugeiconsIcon
                                      icon={UserRemove01Icon}
                                      size={14}
                                      data-icon="inline-start"
                                    />
                                    {t("common.remove")}
                                  </Button>
                                ) : null}
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>

                {awaitingMembers.length > 0 ? (
                  <section aria-labelledby="awaiting-collaborators-heading">
                    <h3
                      id="awaiting-collaborators-heading"
                      className="mb-2 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase"
                    >
                      {t("sharing.awaitingHeading")}
                    </h3>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {awaitingMembers.map((member) => (
                        <li
                          key={member.id}
                          className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <p
                              dir="ltr"
                              className="text-start text-sm font-medium break-all"
                            >
                              {member.email}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {t("sharing.waiting", {
                                role: roleLabel(member.role),
                              })}
                            </p>
                          </div>
                          {memberControls(member).canRemove ? (
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busyActions.has(`remove:${member.id}`)}
                              onClick={() =>
                                setConfirmation({
                                  kind: "remove",
                                  id: member.id,
                                  email: member.email,
                                })
                              }
                              className={pressFeedback}
                            >
                              <HugeiconsIcon
                                icon={UserRemove01Icon}
                                size={14}
                                data-icon="inline-start"
                              />
                              {t("common.remove")}
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <section aria-labelledby="pending-invitations-heading">
                  <h3
                    id="pending-invitations-heading"
                    className="mb-2 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase"
                  >
                    {t("sharing.pendingHeading")}
                  </h3>
                  {collaboration?.invitations.length ? (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {collaboration.invitations.map((invitation) => (
                        <li
                          key={invitation.id}
                          className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <p
                              dir="ltr"
                              className="text-start text-sm font-medium break-all"
                            >
                              {invitation.invited_email}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {invitation.expires_at
                                ? t.rich("sharing.expires", {
                                    role: roleLabel(invitation.role),
                                    date:
                                      format.date(
                                        invitation.expires_at,
                                        true
                                      ) || t("sharing.unknownExpiry"),
                                    time: (chunks) => (
                                      <time dateTime={invitation.expires_at!}>
                                        {chunks}
                                      </time>
                                    ),
                                  })
                                : t("sharing.noExpiry", {
                                    role: roleLabel(invitation.role),
                                  })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyActions.has(
                                `resend:${invitation.id}`
                              )}
                              onClick={() => void resend(invitation)}
                              className={pressFeedback}
                            >
                              {!busyActions.has(`resend:${invitation.id}`) && (
                                <HugeiconsIcon
                                  icon={RotateClockwiseIcon}
                                  size={14}
                                  data-icon="inline-start"
                                />
                              )}
                              {busyActions.has(`resend:${invitation.id}`)
                                ? t("sharing.sending")
                                : t("sharing.resend")}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busyActions.has(
                                `revoke:${invitation.id}`
                              )}
                              onClick={() =>
                                setConfirmation({
                                  kind: "revoke",
                                  id: invitation.id,
                                  email: invitation.invited_email,
                                })
                              }
                              className={pressFeedback}
                            >
                              <HugeiconsIcon
                                icon={Cancel01Icon}
                                size={14}
                                data-icon="inline-start"
                              />
                              {t("sharing.revoke")}
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("sharing.noPending")}
                    </p>
                  )}
                </section>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        confirmation={confirmation}
        open={confirmation !== null}
        busy={
          confirmation !== null &&
          busyActions.has(`${confirmation.kind}:${confirmation.id}`)
        }
        cancelRef={cancelConfirmationRef}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && busyActionsRef.current.size === 0) {
            setConfirmation(null)
          }
        }}
        onConfirm={() => void confirmAction()}
      />
    </>
  )
}
