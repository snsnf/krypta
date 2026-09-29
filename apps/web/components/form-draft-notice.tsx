"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { FloppyDiskIcon } from "@hugeicons/core-free-icons"
import { useFormT } from "@/lib/form-i18n"

interface FormDraftNoticeProps {
  /**
   * Whether a draft is on this device right now, answered by the write having
   * landed. Not "are there answers on screen": those two disagree while a write
   * is still debounced and whenever storage is blocked, and this notice is the
   * wrong place to guess, since it is a promise about what a later reader of
   * this machine could find.
   */
  hasDraft: boolean
  /**
   * Whether restoring dropped answers the form can no longer hold, after the
   * creator edited it. Worth one line: the notice promises their work is kept,
   * and quietly deleting part of it would make that promise false.
   */
  staleAnswersDropped?: boolean
  onDiscard: () => void
}

/**
 * Tells the respondent their answers are on this device, and gives them the
 * one control that removes them.
 *
 * This notice is not decoration. The page promises a page above that the
 * response is encrypted in the browser, and a draft is the one part of that
 * flow sitting in the clear on local disk. Someone filling this in on a shared
 * or borrowed machine has to be able to see that, and to undo it, without
 * being asked to know what localStorage is. Do not hide it behind a details
 * disclosure or reduce it to an icon.
 *
 * It is the lower row of the seal card rather than a line of its own, below a
 * divider and quieter than the seal, so it reads as a qualification of that
 * promise and never as something the promise describes. It is always mounted
 * so the card can grow open when the first write lands and close again on
 * discard; while closed it is `visibility: hidden`, which takes it out of the
 * tab order and the accessibility tree rather than merely out of sight.
 */
export function FormDraftNotice({
  hasDraft,
  staleAnswersDropped = false,
  onDiscard,
}: FormDraftNoticeProps) {
  const t = useFormT()
  return (
    <div
      data-open={hasDraft}
      className="grid grid-rows-[0fr] transition-[grid-template-rows,visibility] duration-300 ease-out data-[open=false]:invisible data-[open=true]:grid-rows-[1fr] motion-reduce:transition-none"
    >
      <div className="min-h-0 overflow-hidden">
        <div
          data-open={hasDraft}
          className="mt-2 border-t border-[color-mix(in_oklab,var(--form-accent)_16%,transparent)] pt-2 opacity-0 transition-opacity delay-75 duration-300 ease-out data-[open=true]:opacity-100 motion-reduce:transition-none sm:mt-2.5 sm:pt-2.5"
        >
          <div className="flex items-center gap-2 sm:gap-2.5">
            <HugeiconsIcon
              icon={FloppyDiskIcon}
              size={13}
              strokeWidth={1.8}
              className="size-3 shrink-0 opacity-70 sm:size-3.5"
            />
            <p className="flex-1 text-muted-foreground/85">
              {t("draftSaved")}
            </p>
            <button
              type="button"
              onClick={onDiscard}
              aria-label={t("discardSaved")}
              className="relative shrink-0 rounded-md border border-[color-mix(in_oklab,var(--form-accent)_22%,transparent)] px-2 py-0.5 text-foreground/75 transition-colors after:absolute after:-inset-2 after:content-[''] hover:bg-[color-mix(in_oklab,var(--form-accent)_10%,transparent)] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.97]"
            >
              {t("discard")}
            </button>
          </div>
          {staleAnswersDropped && (
            <p className="mt-1.5 ps-5 text-muted-foreground/85 sm:ps-6">
              {t("draftChanged")}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
