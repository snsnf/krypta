"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { ApiClientError, apiFetch } from "@/lib/api"
import { FormUnavailable } from "@/components/form-unavailable"
import {
  INCOMPLETE_LINK,
  describeFormLoadFailure,
  type FormLoadFailure,
} from "@/lib/form-load-failure"
import { loadPublicForm } from "@/lib/load-public-form"
import { readFragmentParam } from "@/lib/form-link"
import {
  buildResponsePayload,
  ResponseTooLargeError,
} from "@/lib/response-payload"
import { usePublicFormAnswers } from "@/hooks/use-public-form-answers"
import { ClassicFormFields } from "@/components/classic-form-fields"
import { FocusFormRenderer } from "@/components/focus-form-renderer"
import { DEFAULT_FORM_THEME, type FormRenderMode } from "@/lib/form-theme"
import { DEFAULT_FORM_SETTINGS } from "@/lib/form-settings"
import { ensureSodiumReady } from "@/lib/sodium-ready"
import { FormHeaderCard } from "@/components/form-header-card"
import { useHeaderImage } from "@/hooks/use-header-image"
import { FormThemeSurface } from "@/components/form-theme-surface"
import { FormDraftNotice } from "@/components/form-draft-notice"
import { hasSubmitted, markSubmitted } from "@/lib/form-draft"
import { HugeiconsIcon } from "@hugeicons/react"
import { LockKeyIcon } from "@hugeicons/core-free-icons"
import { Spinner } from "@/components/spinner"
import {
  ColorModeSwitch,
  revealColorChange,
} from "@/components/theme-toggle"
import { usePrefersDark } from "@/hooks/use-prefers-dark"
import { formTranslator, normalizeFormLanguage } from "@/lib/form-i18n"
import type { FormSettings, FormTheme, Question } from "@krypta/crypto"

export default function PublicFormPage() {
  const { formId } = useParams<{ formId: string }>()
  const [title, setTitle] = useState("")
  const [questions, setQuestions] = useState<Question[]>([])
  const [theme, setTheme] = useState<FormTheme>(DEFAULT_FORM_THEME)
  const [settings, setSettings] = useState<FormSettings>(DEFAULT_FORM_SETTINGS)
  const [schemaKey, setSchemaKey] = useState<string | null>(null)
  const [hasHeaderImage, setHasHeaderImage] = useState(false)
  const headerImageUrl = useHeaderImage(formId, schemaKey, hasHeaderImage)
  const [selectedMode, setSelectedMode] = useState<FormRenderMode | null>(null)
  const prefersDark = usePrefersDark()
  const mode: FormRenderMode = theme.allowDarkMode
    ? (selectedMode ?? (prefersDark ? "dark" : "light"))
    : "light"
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [acceptingResponses, setAcceptingResponses] = useState(false)
  const {
    answers,
    draftSaved,
    staleAnswersDropped,
    discardDraft,
    setAnswer,
    toggleCheckboxOption,
    handleFileSelect,
    uploadingIds,
    uploadErrors,
    missingRequired,
  } = usePublicFormAnswers(formId, publicKey, true, questions)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [alreadySubmitted, setAlreadySubmitted] = useState(false)
  const [editLink, setEditLink] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<FormLoadFailure | null>(null)
  // A message key rather than text, so it is worded in the form's language
  // when it is shown.
  const [submitError, setSubmitError] = useState<
    "tooLong" | "submitFailed" | null
  >(null)
  const t = formTranslator(normalizeFormLanguage(theme.language))

  useEffect(() => {
    ;(async () => {
      try {
        await ensureSodiumReady()
        const key = readFragmentParam(window.location.hash, "key")
        if (key === null) {
          setLoadError(INCOMPLETE_LINK)
          setLoading(false)
          return
        }
        const form = await loadPublicForm(formId, key)
        setTitle(form.title)
        setQuestions(form.questions)
        setTheme(form.theme)
        setSettings(form.settings)
        setSchemaKey(key)
        setPublicKey(form.publicKey)
        setHasHeaderImage(form.headerImage)
        setAcceptingResponses(form.acceptingResponses)
        if (!form.settings.allowMultipleResponses && hasSubmitted(formId)) {
          setAlreadySubmitted(true)
          // The form will never be shown again on this device, so the draft
          // behind it is unreachable content with nothing left to resume.
          discardDraft()
        }
        setLoading(false)
      } catch (error) {
        setLoadError(describeFormLoadFailure(error))
        setLoading(false)
      }
    })()
    // discardDraft is stable for a given formId, so this still runs once.
  }, [formId, discardDraft])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!publicKey) return
    setSubmitError(null)
    setSubmitting(true)
    try {
      const payload = buildResponsePayload(questions, answers, publicKey)
      const result = await apiFetch<{ id: string; edit_token: string | null }>(
        `/forms/${formId}/responses`,
        { method: "POST", body: JSON.stringify(payload) }
      )
      if (!settings.allowMultipleResponses) {
        markSubmitted(formId)
      }
      // The answers are sealed and delivered, so the plaintext copy on this
      // device has outlived its purpose. Leaving it would mean a respondent
      // who has finished still has their answers readable on a shared machine.
      discardDraft()
      if (result.edit_token && schemaKey) {
        setEditLink(
          `${window.location.origin}/f/${formId}/r#token=${encodeURIComponent(result.edit_token)}&key=${encodeURIComponent(schemaKey)}`
        )
      }
      setSubmitted(true)
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "form_closed") {
        setAcceptingResponses(false)
        return
      }
      if (error instanceof ResponseTooLargeError) {
        setSubmitError("tooLong")
        return
      }
      setSubmitError("submitFailed")
    } finally {
      setSubmitting(false)
    }
  }

  if (loadError) {
    return <FormUnavailable failure={loadError} theme={theme} mode={mode} />
  }

  if (loading) {
    return (
      <FormThemeSurface
        theme={theme}
        mode={mode}
        className="flex min-h-svh items-center justify-center px-4"
      >
        <Spinner className="size-6" />
      </FormThemeSurface>
    )
  }

  if (alreadySubmitted && !submitted) {
    return (
      <FormThemeSurface
        theme={theme}
        mode={mode}
        className="flex min-h-svh flex-col items-center justify-center px-4 text-center"
      >
        <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-8">
          <p className="form-theme-header font-medium">
            {t("alreadyResponded")}
          </p>
          <p className="form-theme-text mt-2 text-muted-foreground">
            {t("oneResponse")}
          </p>
        </div>
      </FormThemeSurface>
    )
  }

  if (submitted) {
    return (
      <FormThemeSurface
        theme={theme}
        mode={mode}
        className="flex min-h-svh flex-col items-center justify-center px-4 text-center"
      >
        <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-8">
          <div className="form-theme-accent-bg mx-auto mb-4 h-1.5 w-12 rounded-full" />
          <p
            dir={settings.confirmationMessage ? "auto" : undefined}
            className="form-theme-header animate-confirm-in font-medium"
          >
            {settings.confirmationMessage ?? t("thanks")}
          </p>
          <p className="form-theme-text mt-2 text-muted-foreground">
            {t("sealedNote")}
          </p>
          {editLink && (
            <div className="mt-4 rounded-lg border border-primary/25 bg-primary/[0.04] p-3 text-start text-sm">
              <p className="form-theme-text mb-1 font-medium">
                {t("editLinkNote")}
              </p>
              <code className="form-theme-text break-all text-muted-foreground">
                {editLink}
              </code>
            </div>
          )}
        </div>
      </FormThemeSurface>
    )
  }

  if (!acceptingResponses) {
    return (
      <FormThemeSurface
        theme={theme}
        mode={mode}
        className="flex min-h-svh flex-col items-center justify-center px-4 text-center"
      >
        <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-8">
          <FormHeaderCard title={title} headerImageUrl={headerImageUrl} />
          <p className="form-theme-text mt-4 font-medium">
            {t("notAccepting")}
          </p>
        </div>
      </FormThemeSurface>
    )
  }

  const isFocusLayout = (theme.layout ?? "classic") === "focus"

  return (
    <FormThemeSurface
      theme={theme}
      mode={mode}
      /*
       * Focus shows one question at a time, so it becomes a column that fills
       * the screen: the renderer takes the free space and centres the question
       * in it, and the seal settles at the bottom instead of pushing the card
       * above the viewport's middle. Classic is a list that scrolls, so it
       * keeps flowing from the top.
       */
      className={`min-h-svh px-4 py-10 sm:py-14 ${isFocusLayout ? "flex flex-col" : ""}`}
    >
      {theme.allowDarkMode && (
        <div className="mx-auto mb-2 flex w-full max-w-3xl justify-end">
          {/*
           * The site's own theme switch, coloured from the form's theme so it
           * belongs to this page and not to krypta's chrome. System is the
           * form's starting state: it follows the device until someone picks.
           */}
          <ColorModeSwitch
            value={selectedMode ?? "system"}
            label={t("colorMode")}
            optionLabels={{
              light: t("colorLight"),
              system: t("colorSystem"),
              dark: t("colorDark"),
            }}
            onChange={(value, x, y) =>
              revealColorChange(x, y, () =>
                setSelectedMode(value === "system" ? null : value)
              )
            }
            className="border-[color-mix(in_oklch,var(--foreground)_16%,transparent)] bg-[color-mix(in_oklch,var(--card)_45%,transparent)]"
            pillClassName="bg-[var(--card)] shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_18%,transparent)]"
          />
        </div>
      )}
      {isFocusLayout ? (
        <FocusFormRenderer
          title={title}
          questions={questions}
          answers={answers}
          onAnswerChange={setAnswer}
          onToggleCheckbox={toggleCheckboxOption}
          onFileSelect={handleFileSelect}
          uploadingIds={uploadingIds}
          uploadErrors={uploadErrors}
          missingRequired={missingRequired}
          submitting={submitting}
          submitError={submitError && t(submitError)}
          onSubmit={handleSubmit}
        />
      ) : (
        <ClassicFormFields
          headerImageUrl={headerImageUrl}
          title={title}
          questions={questions}
          answers={answers}
          onAnswerChange={setAnswer}
          onToggleCheckbox={toggleCheckboxOption}
          onFileSelect={handleFileSelect}
          uploadingIds={uploadingIds}
          uploadErrors={uploadErrors}
          missingRequired={missingRequired}
          submitting={submitting}
          submitError={submitError && t(submitError)}
          onSubmit={handleSubmit}
        />
      )}
      {/*
       * A seal rather than a line of fine print. This is the one promise the
       * page makes to someone about to type something sensitive into it, and
       * as loose mono text below the fold it read like a disclaimer.
       *
       * Wording is unchanged and must stay that way: it states what actually
       * happens, which is that the browser seals the response and only holders
       * of a key can open it.
       *
       * Not a full pill: the sentence wraps to two lines on a phone, and
       * rounded-full around wrapped text reads as a mistake.
       */}
      {/* Same px as the surface, so its edges line up with the form above it. */}
      <div className="mt-12 flex justify-center pb-4">
        <div className="form-theme-text w-full max-w-md rounded-lg border border-[color-mix(in_oklab,var(--form-accent)_18%,transparent)] bg-[color-mix(in_oklab,var(--form-accent)_7%,transparent)] px-3 py-2 text-[0.625rem] leading-snug text-muted-foreground sm:rounded-xl sm:px-3.5 sm:py-2.5 sm:text-[0.6875rem]">
          <p className="flex items-center gap-2 sm:gap-2.5">
            <HugeiconsIcon
              icon={LockKeyIcon}
              size={13}
              strokeWidth={1.8}
              className="form-theme-accent-text size-3 shrink-0 sm:size-3.5"
            />
            {t("footerSeal")}
          </p>
          {/*
           * Inside the seal's card, below a divider, never above the seal. The
           * seal states the promise; this qualifies it. In the other order
           * "saved on this device" is read first and "encrypted in your
           * browser" then looks like it describes the saved copy, which is
           * exactly the thing that is not true.
           */}
          <FormDraftNotice
            hasDraft={draftSaved}
            staleAnswersDropped={staleAnswersDropped}
            onDiscard={discardDraft}
          />
        </div>
      </div>
    </FormThemeSurface>
  )
}
