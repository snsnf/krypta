"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { CreditCardIcon } from "@hugeicons/core-free-icons"
import { apiFetch, apiFetchWithStatus, ApiClientError } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"

interface SubscriptionResponse {
  plan_id: string
  status: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  responses_used: number
  // Null is "no cap". The API can return it, so this models it rather than
  // rendering "of null" if it ever does.
  max_responses_per_period: number | null
  // False when the number above is a paid plan's fair-use ceiling rather
  // than a limit the account will ever meet. The API decides this, because
  // only it can tell a plan ceiling apart from an admin override that
  // genuinely lowered the allowance.
  responses_metered: boolean
  max_open_forms: number
  forms_metered: boolean
  open_forms_used: number
  max_attachment_bytes: number
  attachment_bytes_used: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

// `time`'s RFC3339 serializer has rendered as "Invalid Date" in this project
// before, so this never trusts the string without checking the parse.
function formatRenewalDate(value: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

function statusLabel(status: string | null): string | null {
  if (!status) return null
  switch (status) {
    case "active":
      return "Active"
    case "trialing":
      return "Trial"
    case "past_due":
      return "Past due"
    case "canceled":
      return "Canceled"
    case "unpaid":
      return "Unpaid"
    case "incomplete":
      return "Incomplete"
    case "incomplete_expired":
      return "Incomplete, expired"
    case "paused":
      return "Paused"
    default:
      return status.replace(/_/g, " ")
  }
}

// `max` of null means there is nothing to fill up, so the track is left out
// entirely rather than drawn permanently empty: a bar at zero reads as a
// limit the account has barely touched, which is the opposite of what an
// unmetered allowance means.
function UsageMeter({
  label,
  used,
  max,
  formatValue,
}: {
  label: string
  used: number
  max: number | null
  formatValue: (value: number) => string
}) {
  const ratio = max !== null && max > 0 ? Math.min(1, used / max) : 0
  const atLimit = max !== null && max > 0 && used >= max
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {max === null
            ? `${formatValue(used)} used, unlimited`
            : `${formatValue(used)} of ${formatValue(max)}`}
        </span>
      </div>
      {max === null ? null : (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${atLimit ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      )}
    </div>
  )
}

// "unavailable" is the 404 case: no Stripe configured on this instance, so
// the billing router was never mounted. Rendered identically to "loading"
// (nothing at all), because both mean "there is nothing to show yet and
// there may never be". "error" is everything else: a real failure the caller
// should be told about, kept visually distinct from both.
type LoadState = "loading" | "unavailable" | "error" | "loaded"

export function PlanPanel() {
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(
    null
  )
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [yearly, setYearly] = useState(false)
  const [busy, setBusy] = useState(false)
  // Bumped by the retry button to re-run the mount effect. Not itself read
  // inside the effect body, only listed as a dependency, so this stays a
  // primitive rather than reintroducing an object identity into the array.
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    apiFetchWithStatus<SubscriptionResponse>("/billing/subscription")
      .then(({ status, data }) => {
        if (cancelled) return
        if (status === 404) {
          // An instance with no Stripe configuration mounts no billing
          // routes at all, so this is not a failure to report: it means
          // billing is not part of this instance.
          setLoadState("unavailable")
          return
        }
        setSubscription(data)
        setLoadState("loaded")
      })
      .catch(() => {
        if (cancelled) return
        setLoadState("error")
      })
    return () => {
      cancelled = true
    }
  }, [retryToken])

  async function handleUpgrade() {
    setBusy(true)
    try {
      const { url } = await apiFetch<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ interval: yearly ? "yearly" : "monthly" }),
      })
      window.location.href = url
    } catch (err) {
      setBusy(false)
      toast.add({
        title:
          err instanceof ApiClientError ? err.message : "Could not start checkout",
        type: "error",
      })
    }
  }

  async function handleManage() {
    setBusy(true)
    try {
      const { url } = await apiFetch<{ url: string }>("/billing/portal", {
        method: "POST",
      })
      window.location.href = url
    } catch (err) {
      setBusy(false)
      toast.add({
        title:
          err instanceof ApiClientError
            ? err.message
            : "Could not open billing management",
        type: "error",
      })
    }
  }

  // Rendering nothing here, before any wrapper markup, is deliberate: a
  // self-hosted instance with no Stripe configuration must never show a
  // heading, a card, or a control for a feature it does not have. This
  // covers both "still loading" and "billing disabled" (the 404 case)
  // identically, on purpose. A genuine failure is handled separately below,
  // because a paying customer whose plan panel silently vanishes on a
  // transient 500 has no way to tell that apart from having no
  // subscription at all.
  if (loadState === "loading" || loadState === "unavailable") return null

  if (loadState === "error" || !subscription) {
    return (
      <>
        <Separator className="my-8" />
        <section>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon icon={CreditCardIcon} size={15} />
            Plan and usage
          </h2>
          <div className="mt-3 space-y-2">
            <p className="text-sm text-muted-foreground">
              Could not load your plan and usage.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLoadState("loading")
                setRetryToken((n) => n + 1)
              }}
            >
              Try again
            </Button>
          </div>
        </section>
      </>
    )
  }

  const isPro = subscription.plan_id === "pro"
  const planLabel = isPro ? "Pro" : subscription.plan_id === "free" ? "Free" : subscription.plan_id
  const status = statusLabel(subscription.status)
  const renewalDate = formatRenewalDate(subscription.current_period_end)

  return (
    <>
      <Separator className="my-8" />
      <section>
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <HugeiconsIcon icon={CreditCardIcon} size={15} />
          Plan and usage
        </h2>

        <div className="mt-3 space-y-4">
          <div>
            <p className="text-sm font-medium">
              {planLabel} plan
              {status ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {status}
                </span>
              ) : null}
            </p>
            {isPro && renewalDate ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {subscription.cancel_at_period_end
                  ? `Your subscription ends on ${renewalDate}.`
                  : `Renews on ${renewalDate}.`}
              </p>
            ) : null}
          </div>

          <div className="space-y-3">
            <UsageMeter
              label="Responses this period"
              used={subscription.responses_used}
              max={
                subscription.responses_metered
                  ? subscription.max_responses_per_period
                  : null
              }
              formatValue={(n) => n.toLocaleString()}
            />
            <UsageMeter
              label="Open forms"
              used={subscription.open_forms_used}
              max={subscription.forms_metered ? subscription.max_open_forms : null}
              formatValue={(n) => n.toLocaleString()}
            />
            <UsageMeter
              label="Attachment storage"
              used={subscription.attachment_bytes_used}
              max={subscription.max_attachment_bytes}
              formatValue={formatBytes}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Reaching a limit blocks adding more until you are back under it, or
            you upgrade. Nothing already stored is ever deleted for being over
            a limit.
          </p>

          {isPro ? (
            <Button size="sm" disabled={busy} onClick={handleManage}>
              {busy ? "Opening..." : "Manage billing"}
            </Button>
          ) : (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={yearly} onCheckedChange={setYearly} />
                Bill yearly (save on the monthly rate)
              </label>
              <Button size="sm" disabled={busy} onClick={handleUpgrade}>
                {busy
                  ? "Starting checkout..."
                  : yearly
                    ? "Upgrade, $120/year"
                    : "Upgrade, $12/month"}
              </Button>
            </div>
          )}
        </div>
      </section>
    </>
  )
}
