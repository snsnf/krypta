"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { ViewIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"

/**
 * Opens the form preview. Lives in the app header beside Share and Copy link.
 * Hidden on phones: the header has no room for it at 375px, and the editor
 * itself is already a faithful view of the form at that width.
 */
export function PreviewButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="Preview"
      onClick={onClick}
      className="hidden transition-transform duration-150 ease-out active:scale-[0.97] sm:inline-flex"
    >
      <HugeiconsIcon icon={ViewIcon} size={15} data-icon="inline-start" />
      Preview
    </Button>
  )
}
