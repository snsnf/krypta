"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  CheckmarkCircle02Icon,
  Copy01Icon,
  Download01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { toast } from "@/components/ui/toast"

interface RecoveryCodeCardProps {
  code: string
  onConfirm: () => void
}

/**
 * The one moment a vault recovery code is visible.
 *
 * The code is held by the caller in component state and never persisted, never
 * logged, and dropped on confirm. Only a verifier derived from it ever reached
 * the server, so nothing here can be shown again: not by this app, not by an
 * operator with a database dump.
 *
 * The acknowledgement gates the continue button rather than merely warning,
 * because the cost of clicking past this screen is total and silent: the
 * account keeps working until the day the password is forgotten.
 */
export function RecoveryCodeCard({ code, onConfirm }: RecoveryCodeCardProps) {
  const [acknowledged, setAcknowledged] = useState(false)

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      toast.add({ title: "Recovery code copied", type: "success" })
    } catch {
      toast.add({
        title: "Could not copy",
        description: "Select the code and copy it manually.",
        type: "error",
      })
    }
  }

  function downloadCode() {
    const blob = new Blob(
      [
        "Krypta vault recovery code\n\n",
        `${code}\n\n`,
        "This recovers your encrypted forms and responses if you forget your\n",
        "password. It is not a two-factor recovery code. Keep it somewhere\n",
        "only you can reach. Nobody can reissue it.\n",
      ],
      { type: "text/plain" }
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "krypta-recovery-code.txt"
    link.click()
    // Revoked on the next tick rather than immediately: some browsers read the
    // blob after the click returns, and revoking first cancels the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-2">
        <h1 className="font-heading text-2xl font-medium tracking-[-0.01em]">
          Save your recovery code
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This is the only time it is shown. If you forget your password, this
          code is the only thing that can recover your forms and responses;
          without it they stay encrypted forever.
        </p>
      </div>

      <p
        data-testid="recovery-code"
        className="rounded-lg border border-primary/25 bg-primary/[0.04] p-4 text-center font-mono text-sm leading-6 tracking-wide break-all select-all"
      >
        {code}
      </p>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={copyCode}
        >
          <HugeiconsIcon icon={Copy01Icon} size={14} data-icon="inline-start" />
          Copy
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={downloadCode}
        >
          <HugeiconsIcon
            icon={Download01Icon}
            size={14}
            data-icon="inline-start"
          />
          Download
        </Button>
      </div>

      <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        This is <strong className="font-medium text-foreground">not</strong> a
        two-factor recovery code. Two-factor codes get you back into your
        account when you lose your authenticator; they cannot decrypt anything.
        This one decrypts your vault and does nothing for signing in.
      </p>

      <label className="flex items-start gap-3 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
        />
        <span>
          I have saved this code somewhere safe. I understand it will not be
          shown again.
        </span>
      </label>

      <Button type="button" disabled={!acknowledged} onClick={onConfirm}>
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          size={16}
          data-icon="inline-start"
        />
        Continue
      </Button>
    </div>
  )
}
