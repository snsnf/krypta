"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { FloppyDiskIcon, Loading03Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"
import { useAppT } from "@/lib/app-i18n"
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
  const t = useAppT()

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
      toast.add({ title: t("admin.instance.saved"), type: "success" })
    } catch {
      toast.add({
        title: t("admin.instance.saveFailed"),
        description: t("admin.instance.saveFailedBody"),
        type: "error",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <section>
      <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
        {t("admin.instance.title")}
      </h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {t("admin.instance.body")}
      </p>

      <div className="mt-8 max-w-xl rounded-xl border border-border p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">
              {t("admin.instance.registration")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("admin.instance.registrationBody")}
            </p>
          </div>
          <Switch
            checked={registrationEnabled}
            onCheckedChange={setRegistrationEnabled}
            disabled={pending}
            aria-label={t("admin.instance.enableRegistration")}
          />
        </div>

        <Separator className="my-5" />

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            {t("admin.instance.registerRate")}
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
            {t("admin.instance.loginRate")}
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
            {t("admin.instance.formQuota")}
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
            {t("admin.instance.attachmentQuota")}
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
            {t("admin.instance.responsesQuota")}
            <Input
              type="number"
              min="0"
              inputMode="numeric"
              placeholder={t("admin.instance.unlimited")}
              value={maxResponses}
              onChange={(event) => setMaxResponses(event.target.value)}
              disabled={pending}
            />
            <span className="text-xs font-normal text-muted-foreground">
              {t("admin.instance.noCap")}
            </span>
          </label>
        </div>

        {settings.billingEnabled ? (
          <p className="mt-4 text-xs text-muted-foreground">
            {t("admin.instance.billingNote")}
          </p>
        ) : null}

        <Separator className="my-5" />
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">{t("admin.instance.mail")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {settings.mailConfigured
                ? t("admin.instance.mailOn")
                : t("admin.instance.mailOff")}
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">
            {settings.mailConfigured
              ? t("admin.instance.configured")
              : t("admin.instance.unavailable")}
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
                <span className="invisible">{t("admin.instance.save")}</span>
                <span>{t("common.saving")}</span>
              </span>
            ) : (
              t("admin.instance.save")
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}
