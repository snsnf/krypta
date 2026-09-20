"use client"

import { useState } from "react"
import type { FormTheme, Question } from "@krypta/crypto"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormThemeSurface } from "@/components/form-theme-surface"
import { Button } from "@/components/ui/button"
import { revealColorChange } from "@/components/theme-toggle"
import { ClassicFormFields } from "@/components/classic-form-fields"
import { FocusFormRenderer } from "@/components/focus-form-renderer"
import type { AnswerValue } from "@/hooks/use-public-form-answers"
import type { FormRenderMode } from "@/lib/form-theme"

interface FormPreviewProps {
  /** Resolved object URL for the header image, or null when there is none. */
  headerImageUrl?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  questions: Question[]
  theme: FormTheme
}

const EMPTY_UPLOADING: Set<string> = new Set()
const EMPTY_ERRORS: Record<string, string> = {}

export function FormPreview({
  open,
  onOpenChange,
  title,
  questions,
  theme,
  headerImageUrl = null,
}: FormPreviewProps) {
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({})
  const [mode, setMode] = useState<FormRenderMode>("light")
  // Bumped on restart to force a fresh mount of the renderer below, so
  // Focus's current-question index and Classic's current-page index both
  // reset to the start instead of staying wherever they were when
  // "submitted".
  const [restartKey, setRestartKey] = useState(0)
  const renderMode: FormRenderMode = theme.allowDarkMode ? mode : "light"

  function setAnswer(qid: string, value: AnswerValue) {
    setAnswers((a) => ({ ...a, [qid]: value }))
  }

  function toggleCheckboxOption(qid: string, opt: string) {
    setAnswers((a) => {
      const current = (a[qid] as string[] | undefined) ?? []
      const next = current.includes(opt)
        ? current.filter((o) => o !== opt)
        : [...current, opt]
      return { ...a, [qid]: next }
    })
  }

  // Preview never uploads for real; selecting a file just marks the
  // question answered so an owner can see the "uploaded" state.
  function selectPreviewFile(qid: string, file: File | undefined) {
    if (!file) return
    setAnswer(qid, {
      attachmentId: "preview",
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    })
  }

  // Nothing is saved or submitted in preview; looping back to the start
  // lets the owner replay the flow.
  function restart() {
    setAnswers({})
    setRestartKey((k) => k + 1)
  }

  const sharedProps = {
    title,
    headerImageUrl,
    questions,
    answers,
    onAnswerChange: setAnswer,
    onToggleCheckbox: toggleCheckboxOption,
    onFileSelect: selectPreviewFile,
    uploadingIds: EMPTY_UPLOADING,
    uploadErrors: EMPTY_ERRORS,
    missingRequired: () => false,
    submitting: false,
    submitError: null,
    onSubmit: restart,
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>
            This is what respondents will see. Nothing here is saved or
            submitted.
          </DialogDescription>
        </DialogHeader>
        <FormThemeSurface
          theme={theme}
          mode={renderMode}
          className="max-h-[60vh] space-y-4 overflow-y-auto overscroll-contain rounded-lg p-4"
        >
          {theme.allowDarkMode && (
            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="Preview color mode"
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={renderMode === "light"}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  revealColorChange(
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2,
                    () => setMode("light")
                  )
                }}
                className="form-theme-outline-button transition-transform duration-150 ease-out active:scale-[0.97]"
              >
                Light preview
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={renderMode === "dark"}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  revealColorChange(
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2,
                    () => setMode("dark")
                  )
                }}
                className="form-theme-outline-button transition-transform duration-150 ease-out active:scale-[0.97]"
              >
                Dark preview
              </Button>
            </div>
          )}
          {(theme.layout ?? "classic") === "focus" ? (
            <FocusFormRenderer key={restartKey} {...sharedProps} />
          ) : (
            <ClassicFormFields key={restartKey} {...sharedProps} />
          )}
        </FormThemeSurface>
      </DialogContent>
    </Dialog>
  )
}
