"use client"

import { useEffect, useState } from "react"
import { FormUnavailable } from "@/components/form-unavailable"
import {
  INCOMPLETE_EDIT_LINK,
  describeFormLoadFailure,
  type FormLoadFailure,
} from "@/lib/form-load-failure"
import { useParams } from "next/navigation"
import { readFragmentParam } from "@/lib/form-link"
import type { FormTheme, Question } from "@krypta/crypto"
import { apiFetch } from "@/lib/api"
import { loadPublicForm } from "@/lib/load-public-form"
import { useHeaderImage } from "@/hooks/use-header-image"
import { visibleQuestions } from "@/lib/form-visibility"
import {
  buildResponsePayload,
  ResponseTooLargeError,
} from "@/lib/response-payload"
import { usePublicFormAnswers } from "@/hooks/use-public-form-answers"
import { FormQuestionCard } from "@/components/form-question-card"
import { DEFAULT_FORM_THEME } from "@/lib/form-theme"
import { ensureSodiumReady } from "@/lib/sodium-ready"
import { FormHeaderCard } from "@/components/form-header-card"
import { FormThemeSurface } from "@/components/form-theme-surface"
import { Spinner } from "@/components/spinner"
import { Button } from "@/components/ui/button"

export default function EditResponsePage() {
  const { formId } = useParams<{ formId: string }>()
  const [token, setToken] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [questions, setQuestions] = useState<Question[]>([])
  const [theme, setTheme] = useState<FormTheme>(DEFAULT_FORM_THEME)
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const {
    answers,
    setAnswer,
    toggleCheckboxOption,
    handleFileSelect,
    uploadingIds,
    uploadErrors,
    missingRequired,
  } = usePublicFormAnswers(formId, publicKey)
  const visible = visibleQuestions(questions, answers)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [loadError, setLoadError] = useState<FormLoadFailure | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [schemaKey, setSchemaKey] = useState<string | null>(null)
  const [hasHeaderImage, setHasHeaderImage] = useState(false)
  const headerImageUrl = useHeaderImage(formId, schemaKey, hasHeaderImage)

  useEffect(() => {
    ;(async () => {
      try {
        await ensureSodiumReady()
        const token = readFragmentParam(window.location.hash, "token")
        const key = readFragmentParam(window.location.hash, "key")
        if (token === null || key === null) {
          setLoadError(INCOMPLETE_EDIT_LINK)
          setLoading(false)
          return
        }
        setToken(token)
        const form = await loadPublicForm(formId, key)
        setSchemaKey(key)
        setHasHeaderImage(form.headerImage)
        setTitle(form.title)
        setQuestions(form.questions)
        setTheme(form.theme)
        setPublicKey(form.publicKey)
        setLoading(false)
      } catch (error) {
        setLoadError(describeFormLoadFailure(error))
        setLoading(false)
      }
    })()
  }, [formId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!publicKey || !token) return
    setSubmitError(null)
    setSubmitting(true)
    try {
      const payload = buildResponsePayload(questions, answers, publicKey)
      await apiFetch(`/forms/${formId}/responses/edit`, {
        method: "PATCH",
        headers: { "X-Response-Token": token },
        body: JSON.stringify(payload),
      })
      setSubmitted(true)
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        setSubmitError(
          "Your answers are too long to send. Shorten your longest answer and try again."
        )
        return
      }
      setSubmitError(
        "Something went wrong saving your changes. This link may have expired."
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (loadError) {
    return <FormUnavailable failure={loadError} theme={theme} />
  }

  if (loading) {
    return (
      <FormThemeSurface
        theme={theme}
        className="flex min-h-svh items-center justify-center px-4"
      >
        <Spinner className="size-6" />
      </FormThemeSurface>
    )
  }

  if (submitted) {
    return (
      <FormThemeSurface
        theme={theme}
        className="flex min-h-svh flex-col items-center justify-center px-4 text-center"
      >
        <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-8">
          <div className="form-theme-accent-bg mx-auto mb-4 h-1.5 w-12 rounded-full" />
          <p className="form-theme-header animate-confirm-in font-medium">
            Your response was updated.
          </p>
        </div>
      </FormThemeSurface>
    )
  }

  return (
    <FormThemeSurface theme={theme} className="min-h-svh px-4 py-10 sm:py-14">
      <form
        onSubmit={handleSubmit}
        className="mx-auto w-full max-w-3xl space-y-4"
      >
        <FormHeaderCard title={title} headerImageUrl={headerImageUrl} />
        <p className="form-theme-text text-muted-foreground">
          Editing replaces your previous answers. Since only authorized
          collaborators can decrypt submitted responses, this form can&apos;t
          show you what you answered before.
        </p>
        {visible.map((q) => (
          <FormQuestionCard
            key={q.id}
            question={q}
            value={answers[q.id]}
            onAnswerChange={(value) => setAnswer(q.id, value)}
            onToggleCheckbox={(opt) => toggleCheckboxOption(q.id, opt)}
            onFileSelect={(file) => handleFileSelect(q.id, file)}
            uploading={uploadingIds.has(q.id)}
            uploadError={uploadErrors[q.id]}
          />
        ))}
        {submitError && (
          <p aria-live="polite" className="text-sm text-destructive">
            {submitError}
          </p>
        )}
        <Button
          type="submit"
          disabled={
            submitting || missingRequired(visible) || uploadingIds.size > 0
          }
          className="form-theme-accent-bg form-theme-button form-theme-text active:scale-[0.97]"
        >
          {submitting ? "Saving..." : "Save changes"}
        </Button>
      </form>
    </FormThemeSurface>
  )
}
