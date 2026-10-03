"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { CreditCardIcon } from "@hugeicons/core-free-icons"
import { apiFetch, apiFetchWithStatus, ApiClientError } from "@/lib/api"
import {
  useAppFormat,
  useAppLanguage,
  useAppT,
  translateKey,
} from "@/lib/app-i18n"
import { describeApiError } from "@/lib/api-error-text"
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

function statusKey(status: string | null): string | null {
  if (!status) return null
  return Object.hasOwn(STATUS_KEYS, status) ? STATUS_KEYS[status] : null
}

const STATUS_KEYS: Record<string, string> = {
  active: "account.plan.status.active",
  trialing: "account.plan.status.trialing",
  past_due: "account.plan.status.past_due",
  canceled: "account.plan.status.canceled",
  unpaid: "account.plan.status.unpaid",
  incomplete: "account.plan.status.incomplete",
  incomplete_expired: "account.plan.status.incomplete_expired",
  paused: "account.plan.status.paused",
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
  const t = useAppT()
  const ratio = max !== null && max > 0 ? Math.min(1, used / max) : 0
  const atLimit = max !== null && max > 0 && used >= max
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {max === null
            ? t("account.plan.usedUnlimited", { used: formatValue(used) })
            : t("account.plan.usedOf", {
                used: formatValue(used),
                max: formatValue(max),
              })}
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
  const t = useAppT()
  const language = useAppLanguage()
  const format = useAppFormat()
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
          err instanceof ApiClientError
            ? describeApiError(err, t, language)
            : t("account.plan.checkoutFailed"),
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
            ? describeApiError(err, t, language)
            : t("account.plan.portalFailed"),
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
            {t("account.plan.heading")}
          </h2>
          <div className="mt-3 space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("account.plan.loadFailed")}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLoadState("loading")
                setRetryToken((n) => n + 1)
              }}
            >
              {t("common.tryAgain")}
            </Button>
          </div>
        </section>
      </>
    )
  }

  const isPro = subscription.plan_id === "pro"
  const planLabel = isPro
    ? t("account.plan.pro")
    : subscription.plan_id === "free"
      ? t("account.plan.free")
      : subscription.plan_id
  const knownStatus = statusKey(subscription.status)
  const status = knownStatus
    ? translateKey(t, knownStatus)
    : subscription.status?.replace(/_/g, " ")
  // `time`'s RFC3339 serializer has rendered as "Invalid Date" in this project
  // before, so the formatter returns "" for anything it cannot parse.
  const renewalDate = subscription.current_period_end
    ? format.date(subscription.current_period_end)
    : ""

  return (
    <>
      <Separator className="my-8" />
      <section>
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <HugeiconsIcon icon={CreditCardIcon} size={15} />
          {t("account.plan.heading")}
        </h2>

        <div className="mt-3 space-y-4">
          <div>
            <p className="text-sm font-medium">
              {t("account.plan.planName", { plan: planLabel })}
              {status ? (
                <span className="ms-2 text-xs font-normal text-muted-foreground">
                  {status}
                </span>
              ) : null}
            </p>
            {isPro && renewalDate ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {subscription.cancel_at_period_end
                  ? t("account.plan.ends", { date: renewalDate })
                  : t("account.plan.renews", { date: renewalDate })}
              </p>
            ) : null}
          </div>

          <div className="space-y-3">
            <UsageMeter
              label={t("account.plan.responses")}
              used={subscription.responses_used}
              max={
                subscription.responses_metered
                  ? subscription.max_responses_per_period
                  : null
              }
              formatValue={format.number}
            />
            <UsageMeter
              label={t("account.plan.openForms")}
              used={subscription.open_forms_used}
              max={
                subscription.forms_metered ? subscription.max_open_forms : null
              }
              formatValue={format.number}
            />
            <UsageMeter
              label={t("account.plan.attachments")}
              used={subscription.attachment_bytes_used}
              max={subscription.max_attachment_bytes}
              formatValue={format.bytes}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("account.plan.limitNote")}
          </p>

          {isPro ? (
            <Button size="sm" disabled={busy} onClick={handleManage}>
              {busy ? t("account.plan.opening") : t("account.plan.manage")}
            </Button>
          ) : (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={yearly} onCheckedChange={setYearly} />
                {t("account.plan.yearly")}
              </label>
              <Button size="sm" disabled={busy} onClick={handleUpgrade}>
                {busy
                  ? t("account.plan.starting")
                  : yearly
                    ? t("account.plan.upgradeYearly")
                    : t("account.plan.upgradeMonthly")}
              </Button>
            </div>
          )}
        </div>
      </section>
    </>
  )
}
