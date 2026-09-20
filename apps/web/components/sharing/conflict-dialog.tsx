"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface ConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCopyDraft: () => Promise<void>
  onReloadLatest: () => void
}

const pressFeedback =
  "transition-transform duration-150 ease-out active:translate-y-0 active:scale-[0.97] motion-reduce:active:scale-100"

export function ConflictDialog({
  open,
  onOpenChange,
  onCopyDraft,
  onReloadLatest,
}: ConflictDialogProps) {
  const keepEditingRef = useRef<HTMLButtonElement>(null)
  const [copying, setCopying] = useState(false)

  async function copyDraft() {
    if (copying) return
    setCopying(true)
    try {
      await onCopyDraft()
    } finally {
      setCopying(false)
    }
  }

  function confirmReload() {
    if (
      window.confirm(
        "Reload the latest version? Your current local draft will be discarded."
      )
    ) {
      onReloadLatest()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sharing-dialog-surface sm:max-w-md"
        overlayClassName="sharing-dialog-overlay"
        showCloseButton={false}
        initialFocus={keepEditingRef}
      >
        <DialogHeader>
          <DialogTitle>This form changed elsewhere</DialogTitle>
          <DialogDescription>
            Your draft is still here. Keep editing, copy it for safekeeping, or
            reload the latest saved version.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            onClick={confirmReload}
            className={pressFeedback}
          >
            Reload latest
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={copying}
            onClick={copyDraft}
            className={pressFeedback}
          >
            Copy my draft
          </Button>
          <Button
            ref={keepEditingRef}
            type="button"
            onClick={() => onOpenChange(false)}
            className={pressFeedback}
          >
            Keep editing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
