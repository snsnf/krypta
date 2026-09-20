"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FloppyDiskIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"
import { updateAdminSettings, type AdminSettings } from "@/lib/admin"

interface InstanceSettingsProps {
  settings: AdminSettings
  onSaved: (settings: AdminSettings) => void
}

function numericValue(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

// Blank means "no cap", which the API stores as null. A value that is not a
// number is treated as blank rather than silently kept, so a typo clears the
// field visibly instead of writing something unintended.
function nullableNumericValue(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === "") return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function InstanceSettings({ settings, onSaved }: InstanceSettingsProps) {
  const [registrationEnabled, setRegistrationEnabled] = useState(
    settings.registrationEnabled
  )
  const [registerRate, setRegisterRate] = useState(
    String(settings.registerRateLimitPerHour)
  )
  const [loginRate, setLoginRate] = useState(
    String(settings.loginRateLimitPerMinute)
  )
  const [maxForms, setMaxForms] = useState(String(settings.defaultMaxForms))
  const [maxAttachments, setMaxAttachments] = useState(
    String(settings.defaultMaxAttachmentBytes)
  )
  const [maxResponses, setMaxResponses] = useState(
    settings.defaultMaxResponsesPerPeriod === null
      ? ""
      : String(settings.defaultMaxResponsesPerPeriod)
  )
  const [pending, setPending] = useState(false)

  async function save(): Promise<void> {
    setPending(true)
    try {
      const updated = await updateAdminSettings({
        registrationEnabled,
        registerRateLimitPerHour: numericValue(
          registerRate,
          settings.registerRateLimitPerHour
        ),
        loginRateLimitPerMinute: numericValue(
          loginRate,
          settings.loginRateLimitPerMinute
        ),
        defaultMaxForms: numericValue(maxForms, settings.defaultMaxForms),
        defaultMaxAttachmentBytes: numericValue(
          maxAttachments,
          settings.defaultMaxAttachmentBytes
        ),
        defaultMaxResponsesPerPeriod: nullableNumericValue(maxResponses),
      })
      onSaved(updated)
      toast.add({ title: "Instance settings saved", type: "success" })
    } catch {
      toast.add({
        title: "Could not save settings",
        description: "Check the values and try again.",
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <section>
      <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
        Instance
      </h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Fixed registration, quota, and rate-limit settings. Deployment secrets
        cannot be viewed or edited here.
      </p>

      <div className="mt-8 max-w-xl rounded-xl border border-border p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Registration</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Allow new accounts to register on this instance.
            </p>
          </div>
          <Switch
            checked={registrationEnabled}
            onCheckedChange={setRegistrationEnabled}
            disabled={pending}
            aria-label="Enable registration"
          />
        </div>

        <Separator className="my-5" />

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Registrations per hour
            <Input
              type="number"
              min="1"
              max="1000"
              inputMode="numeric"
              value={registerRate}
              onChange={(event) => setRegisterRate(event.target.value)}
              disabled={pending}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Logins per minute
            <Input
              type="number"
              min="1"
              max="1000"
              inputMode="numeric"
              value={loginRate}
              onChange={(event) => setLoginRate(event.target.value)}
              disabled={pending}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Default form quota
            <Input
              type="number"
              min="1"
              max="100000"
              inputMode="numeric"
              value={maxForms}
              onChange={(event) => setMaxForms(event.target.value)}
              disabled={pending}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Default attachment quota (bytes)
            <Input
              type="number"
              min="0"
              inputMode="numeric"
              value={maxAttachments}
              onChange={(event) => setMaxAttachments(event.target.value)}
              disabled={pending}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Default responses per month
            <Input
              type="number"
              min="0"
              inputMode="numeric"
              placeholder="Unlimited"
              value={maxResponses}
              onChange={(event) => setMaxResponses(event.target.value)}
              disabled={pending}
            />
            <span className="text-xs font-normal text-muted-foreground">
              Leave blank for no cap.
            </span>
          </label>
        </div>

        {settings.billingEnabled ? (
          <p className="mt-4 text-xs text-muted-foreground">
            This instance bills, so every account resolves its form,
            attachment, and response quota from its plan and the three defaults
            above are never reached. They are the floor for an instance with no
            Stripe configuration.
          </p>
        ) : null}

        <Separator className="my-5" />
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Mail</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {settings.mailConfigured
                ? "Server mail is configured."
                : "Server mail is not configured."}
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">
            {settings.mailConfigured ? "Configured" : "Unavailable"}
          </span>
        </div>

        <div className="mt-6 flex justify-end">
          <Button size="sm" disabled={pending} onClick={save}>
            <HugeiconsIcon
              icon={pending ? Loading03Icon : FloppyDiskIcon}
              size={14}
              className={pending ? "animate-spin" : undefined}
              data-icon="inline-start"
            />
            {pending ? (
              <span className="grid *:col-start-1 *:row-start-1">
                <span className="invisible">Save settings</span>
                <span>Saving...</span>
              </span>
            ) : (
              "Save settings"
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}
