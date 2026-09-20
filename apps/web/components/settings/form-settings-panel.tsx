"use client"

import { useState } from "react"
import type { FormSettings } from "@krypta/crypto"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  localDateTimeToUtcIso,
  utcIsoToLocalDateTime,
} from "@/lib/form-close-date"

interface FormSettingsPanelProps {
  settings: FormSettings
  onSettingsChange: (settings: FormSettings) => void
  allowResponseEditing: boolean
  onAllowResponseEditingChange: (value: boolean) => void
  acceptingResponses: boolean
  onAcceptingResponsesChange: (value: boolean) => void
  notifyOnResponse: boolean
  onNotifyOnResponseChange: (value: boolean) => void
  closesAt: string | null
  onClosesAtChange: (value: string | null) => void
  maxResponses: number | null
  onMaxResponsesChange: (value: number | null) => void
  quizEnabled: boolean
  onQuizEnabledChange: (value: boolean) => void
  canEdit: boolean
  isOwner: boolean
  onDelete: () => Promise<void>
}

/*
 * Eight settings each in its own bordered card gave every one of them the same
 * weight and no relationship to any other, so the page read as a wall rather
 * than as a set of choices. Related settings share one container with rules
 * between them instead, and the group carries the heading. Four borders where
 * there were eight, and a shape a reader can scan.
 */
function SettingsGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="px-1 text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
        {children}
      </div>
    </section>
  )
}

/* Top-aligned: these descriptions run to several lines, and centring the
   switch against them leaves it floating beside the middle of a paragraph. */
function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description: React.ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-5 p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="mt-0.5 shrink-0">
        <Switch
          aria-label={label}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </div>
  )
}

function FieldRow({
  label,
  description,
  children,
}: {
  label: string
  description: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="p-4">
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <div className="mt-3">{children}</div>
    </div>
  )
}

export function FormSettingsPanel({
  settings,
  onSettingsChange,
  allowResponseEditing,
  onAllowResponseEditingChange,
  acceptingResponses,
  onAcceptingResponsesChange,
  notifyOnResponse,
  onNotifyOnResponseChange,
  closesAt,
  onClosesAtChange,
  maxResponses,
  onMaxResponsesChange,
  quizEnabled,
  onQuizEnabledChange,
  canEdit,
  isOwner,
  onDelete,
}: FormSettingsPanelProps) {
  const [deleteConfirmation, setDeleteConfirmation] = useState("")
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // These three inputs commit on blur rather than on every keystroke: the
  // change handlers they call re-encrypt and PATCH the whole form (or, for
  // the close date, can PATCH a transient empty value while the datetime
  // widget is mid-edit). Local state holds what the owner is typing; the
  // committed value only reaches the parent once they leave the field.
  //
  // Resetting local state when a prop changes is done during render (the
  // "adjusting state when a prop changes" pattern), not in a `useEffect`:
  // an effect would set state after an extra render, and this codebase's
  // lint config treats that as an error.
  const [prevClosesAt, setPrevClosesAt] = useState(closesAt)
  const [closesAtInput, setClosesAtInput] = useState(() =>
    utcIsoToLocalDateTime(closesAt)
  )
  if (closesAt !== prevClosesAt) {
    setPrevClosesAt(closesAt)
    setClosesAtInput(utcIsoToLocalDateTime(closesAt))
  }

  const [prevMaxResponses, setPrevMaxResponses] = useState(maxResponses)
  const [maxResponsesInput, setMaxResponsesInput] = useState(() =>
    maxResponses === null ? "" : String(maxResponses)
  )
  if (maxResponses !== prevMaxResponses) {
    setPrevMaxResponses(maxResponses)
    setMaxResponsesInput(maxResponses === null ? "" : String(maxResponses))
  }

  const committedConfirmationMessage = settings.confirmationMessage ?? ""
  const [prevConfirmationMessage, setPrevConfirmationMessage] = useState(
    committedConfirmationMessage
  )
  const [confirmationMessageInput, setConfirmationMessageInput] = useState(
    committedConfirmationMessage
  )
  if (committedConfirmationMessage !== prevConfirmationMessage) {
    setPrevConfirmationMessage(committedConfirmationMessage)
    setConfirmationMessageInput(committedConfirmationMessage)
  }

  function commitClosesAt() {
    const next = localDateTimeToUtcIso(closesAtInput)
    if (next !== closesAt) {
      onClosesAtChange(next)
    }
  }

  function commitMaxResponses() {
    const raw = maxResponsesInput.trim()
    if (raw === "") {
      if (maxResponses !== null) {
        onMaxResponsesChange(null)
      }
      return
    }
    const parsed = Number(raw)
    const isValid =
      Number.isInteger(parsed) && parsed >= 1 && parsed <= 2147483647
    if (!isValid) {
      // Revert to the last committed value rather than sending garbage.
      setMaxResponsesInput(maxResponses === null ? "" : String(maxResponses))
      return
    }
    if (parsed !== maxResponses) {
      onMaxResponsesChange(parsed)
    }
  }

  function commitConfirmationMessage() {
    if (confirmationMessageInput !== (settings.confirmationMessage ?? "")) {
      onSettingsChange({
        ...settings,
        confirmationMessage: confirmationMessageInput,
      })
    }
  }

  async function deleteForm() {
    if (deleteConfirmation !== "DELETE" || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await onDelete()
    } catch {
      setDeleteError("Something went wrong deleting this form.")
      setDeleting(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8">
      {canEdit && (
        <SettingsGroup title="Availability">
          <ToggleRow
            label="Accept responses"
            description="Turn this off to close the public form to new submissions."
            checked={acceptingResponses}
            onCheckedChange={onAcceptingResponsesChange}
          />
          <FieldRow
            label="Close date"
            description="After this date and time, in your local timezone, the form stops accepting responses. Leave blank for no close date."
          >
            <Input
              aria-label="Close date"
              type="datetime-local"
              className="sm:max-w-64"
              value={closesAtInput}
              onChange={(event) => setClosesAtInput(event.target.value)}
              onBlur={commitClosesAt}
            />
          </FieldRow>
          <FieldRow
            label="Response limit"
            description="Once this many responses have been received, the form closes. This counts the responses the form currently holds, not every response it has ever received: deleting responses lowers the count and can reopen the form, and setting a limit lower than the current response count closes the form immediately. Leave blank for no limit."
          >
            <Input
              aria-label="Response limit"
              type="number"
              min="1"
              className="sm:max-w-40"
              value={maxResponsesInput}
              onChange={(event) => setMaxResponsesInput(event.target.value)}
              onBlur={commitMaxResponses}
            />
          </FieldRow>
        </SettingsGroup>
      )}

      {canEdit && (
        <SettingsGroup title="Responses">
          <ToggleRow
            label="Limit to 1 response"
            description="Hides the form for anyone who has already submitted, in the same browser. Since forms have no sign-in, this can be bypassed by clearing browser storage or using a different browser."
            checked={!settings.allowMultipleResponses}
            onCheckedChange={(checked) =>
              onSettingsChange({
                ...settings,
                allowMultipleResponses: !checked,
              })
            }
          />
          <ToggleRow
            label="Allow response editing"
            description={
              <>
                After submitting, respondents get a private link to revise their
                answers. Editing replaces the previous answers; it can&apos;t
                show them what they wrote before, since only active
                collaborators with access to this form can decrypt submitted
                responses.
              </>
            }
            checked={allowResponseEditing}
            onCheckedChange={onAllowResponseEditingChange}
          />
          <FieldRow
            label="Confirmation message"
            description="Shown to respondents after they submit, instead of the default message."
          >
            <Textarea
              aria-label="Confirmation message"
              placeholder="Thanks! Your response was submitted."
              value={confirmationMessageInput}
              onChange={(event) =>
                setConfirmationMessageInput(event.target.value)
              }
              onBlur={commitConfirmationMessage}
            />
          </FieldRow>
        </SettingsGroup>
      )}

      {canEdit && (
        <SettingsGroup title="Quiz">
          <ToggleRow
            label="Quiz"
            description="Mark correct answers and points on each question in the Questions tab, and see every response scored. Respondents never see the answers or their score."
            checked={quizEnabled}
            onCheckedChange={onQuizEnabledChange}
          />
        </SettingsGroup>
      )}

      {/*
       * Always rendered: this preference is per-person rather than part of the
       * form, so a Viewer's Settings tab is this group and nothing else.
       */}
      <SettingsGroup title="Notifications">
        <ToggleRow
          label="Email me when responses arrive"
          description={
            <>
              At most one email an hour, however many arrive. It carries a count
              and a link, never this form&rsquo;s name or any answers, because
              the server cannot read them.
            </>
          }
          checked={notifyOnResponse}
          onCheckedChange={onNotifyOnResponseChange}
        />
      </SettingsGroup>

      {isOwner && (
        <section aria-labelledby="danger-zone-title">
          <h2
            id="danger-zone-title"
            className="px-1 text-xs font-medium tracking-[0.06em] text-destructive uppercase"
          >
            Danger zone
          </h2>
          <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/[0.03] p-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Deleting a form permanently removes its encrypted responses and
              attachments. Type DELETE to confirm.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                aria-label="Type DELETE to confirm"
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoComplete="off"
                className="sm:max-w-56"
              />
              <Button
                type="button"
                variant="destructive"
                disabled={deleteConfirmation !== "DELETE" || deleting}
                onClick={deleteForm}
                className="transition-transform duration-150 ease-out active:translate-y-0 active:scale-[0.97] motion-reduce:active:scale-100"
              >
                {deleting ? "Deleting…" : "Delete form"}
              </Button>
            </div>
            {deleteError && (
              <p className="mt-2 text-sm text-destructive" aria-live="polite">
                {deleteError}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
