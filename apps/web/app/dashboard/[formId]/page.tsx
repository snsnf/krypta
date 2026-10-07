"use client"

import { useEffect, useRef, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { toast } from "@/components/ui/toast"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  CheckmarkCircle02Icon,
  Delete02Icon,
  Download04Icon,
  FileExportIcon,
  Link01Icon,
  Loading03Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import {
  encryptWithKey,
  formKeyCommitment,
  sealPublicKeyFromPrivate,
  encryptBytesWithKey,
  unsealBoxBytes,
  type FormSchema,
  type FormSettings,
  type FormTheme,
  type FormRole,
  type Question,
} from "@krypta/crypto"
import {
  ApiClientError,
  apiFetch,
  apiUploadBytes,
  apiDownloadBytes,
} from "@/lib/api"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAuthStore } from "@/lib/auth-store"
import { useAppT } from "@/lib/app-i18n"
import { ensureSodiumReady } from "@/lib/sodium-ready"
import { useEnsureUnlocked } from "@/hooks/use-ensure-unlocked"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { filterResponses, searchTerms } from "@/lib/response-search"
import { AppHeader } from "@/components/app-header"
import { FullPageSpinner } from "@/components/spinner"
import { FormBuilder } from "@/components/form-builder"
import { PreviewButton } from "@/components/preview-button"
import { FormSettingsPanel } from "@/components/settings/form-settings-panel"
import { SharingDialog } from "@/components/sharing/sharing-dialog"
import { ConflictDialog } from "@/components/sharing/conflict-dialog"
import { FormQuestionCard } from "@/components/form-question-card"
import { FormHeaderCard } from "@/components/form-header-card"
import { useHeaderImage } from "@/hooks/use-header-image"
import { FormThemeSurface } from "@/components/form-theme-surface"
import { WorkspaceUnavailable } from "@/components/workspace-unavailable"
import {
  describeWorkspaceLoadFailure,
  type FormLoadFailure,
} from "@/lib/form-load-failure"
import { ResponseSummaryLazy } from "@/components/responses/response-summary-lazy"
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { DEFAULT_FORM_THEME } from "@/lib/form-theme"
import { DEFAULT_FORM_SETTINGS } from "@/lib/form-settings"
import { reconcileAnswerKey, marksFor, type AnswerKey } from "@/lib/quiz"
import { useQuizGrades } from "@/hooks/use-quiz-grades"
import { ScoreCell } from "@/components/quiz/score-cell"
import { GradeResponseDialog } from "@/components/quiz/grade-response-dialog"
import { QuizSummary } from "@/components/quiz/quiz-summary"
import { nextResponseToGrade, scoreResponse } from "@/lib/quiz-score"
import { sealAnswerKey } from "@/lib/quiz-sealing"
import { ensureAccountSharingKey } from "@/lib/account-sharing-key"
import { csvCell, csvDocument } from "@/lib/csv"
import { loadFormWorkspace } from "@/lib/form-workspace"
import {
  createFormMutationQueue,
  serializeDraftForClipboard,
  type FormMutationQueue,
} from "@/lib/form-mutations"
import {
  formatAnswer,
  isFileAnswer,
  type AnswerValue,
  type FileAnswer,
} from "@/lib/form-answers"
import { attachmentIdsOf } from "@/lib/response-payload"

interface FormLoadIdentity {
  formId: string
  userId: string
  status: "ready" | "error"
}

/*
 * A header image is decorative, and it is decrypted in every respondent's
 * browser before it can be shown, so the cap is about their load rather than
 * about storage. Responses use 10MB; this is deliberately tighter.
 */
const MAX_HEADER_IMAGE_BYTES = 5 * 1024 * 1024

export default function FormDetailPage() {
  useEnsureUnlocked()
  const t = useAppT()
  const { formId } = useParams<{ formId: string }>()
  const router = useRouter()
  const userId = useAuthStore((s) => s.userId)
  const accountKey = useAuthStore((s) => s.accountKey)

  const [tab, setTab] = useState("questions")
  const [title, setTitle] = useState("")
  const [questions, setQuestions] = useState<Question[]>([])
  const [theme, setTheme] = useState<FormTheme>(DEFAULT_FORM_THEME)
  const [answerKey, setAnswerKey] = useState<AnswerKey | null>(null)
  const [settings, setSettings] = useState<FormSettings>(DEFAULT_FORM_SETTINGS)
  const [allowResponseEditing, setAllowResponseEditing] = useState(false)
  const [acceptingResponses, setAcceptingResponses] = useState(false)
  const [notifyOnResponse, setNotifyOnResponse] = useState(false)
  const [closesAt, setClosesAt] = useState<string | null>(null)
  const [maxResponses, setMaxResponses] = useState<number | null>(null)
  const [formDataKey, setFormDataKey] = useState<string | null>(null)
  const [hasHeaderImage, setHasHeaderImage] = useState(false)
  const [headerImageBusy, setHeaderImageBusy] = useState(false)
  const [headerImageError, setHeaderImageError] = useState<string | null>(null)
  const headerImageUrl = useHeaderImage(formId, formDataKey, hasHeaderImage)
  const [formPrivateKey, setFormPrivateKey] = useState<string | null>(null)
  const [formRole, setFormRole] = useState<FormRole | null>(null)
  const [loadIdentity, setLoadIdentity] = useState<FormLoadIdentity | null>(
    null
  )
  const [responses, setResponses] = useState<
    { id: string; answers: Record<string, AnswerValue> }[]
  >([])
  const [responseView, setResponseView] = useState<"summary" | "individual">(
    "summary"
  )
  const [responseQuery, setResponseQuery] = useState("")
  const [saving, setSaving] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [loadFailure, setLoadFailure] = useState<FormLoadFailure | null>(null)
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>(
    {}
  )
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    answers: Record<string, AnswerValue>
  } | null>(null)
  const [unreadableResponses, setUnreadableResponses] = useState(0)
  const quiz = useQuizGrades(
    formId,
    formPrivateKey,
    answerKey?.enabled === true
  )
  const [gradingId, setGradingId] = useState<string | null>(null)
  const versionRef = useRef(0)
  const mutationQueueRef = useRef<FormMutationQueue | null>(null)

  useEffect(() => {
    if (userId === null || accountKey === null) return

    const expectedUserId = userId
    const expectedAccountKey = accountKey
    let cancelled = false

    function isCurrentLoad(): boolean {
      const currentAuth = useAuthStore.getState()
      return (
        !cancelled &&
        currentAuth.userId === expectedUserId &&
        currentAuth.accountKey === expectedAccountKey
      )
    }

    ;(async () => {
      try {
        await ensureSodiumReady()
        const sharingMaterial = await ensureAccountSharingKey({
          expectedUserId,
          accountKey: expectedAccountKey,
        })
        if (!isCurrentLoad()) return

        const workspace = await loadFormWorkspace(
          formId,
          expectedAccountKey,
          sharingMaterial
        )

        if (!isCurrentLoad()) return

        versionRef.current = workspace.version
        const mutationQueue = createFormMutationQueue(
          versionRef,
          async (patch, expectedVersion) => {
            if (!isCurrentLoad()) throw new Error("Form context changed")
            const result = await apiFetch<{ version: number }>(
              `/forms/${formId}`,
              {
                method: "PATCH",
                body: JSON.stringify({
                  ...patch,
                  expected_version: expectedVersion,
                }),
              }
            )
            if (!isCurrentLoad()) throw new Error("Form context changed")
            return result
          }
        )

        mutationQueueRef.current = mutationQueue
        setFormDataKey(workspace.formDataKey)
        setHasHeaderImage(workspace.hasHeaderImage)
        setFormPrivateKey(workspace.formPrivateKey)
        setFormRole(workspace.role)
        setLoadIdentity({ formId, userId: expectedUserId, status: "ready" })
        setTitle(workspace.title)
        setQuestions(workspace.questions)
        setTheme(workspace.theme)
        setAnswerKey(workspace.answerKey)
        setSettings(workspace.settings)
        setAllowResponseEditing(workspace.allowResponseEditing)
        setAcceptingResponses(workspace.acceptingResponses)
        setClosesAt(workspace.closesAt)
        setMaxResponses(workspace.maxResponses)
        setNotifyOnResponse(workspace.notifyOnResponse)
        setResponses(workspace.responses)
        setUnreadableResponses(workspace.unreadableResponses)
        setError(null)
      } catch (cause) {
        if (!isCurrentLoad()) return
        setFormDataKey(null)
        setFormPrivateKey(null)
        setFormRole(null)
        setLoadIdentity({ formId, userId: expectedUserId, status: "error" })
        setLoadFailure(describeWorkspaceLoadFailure(cause))
      }
    })()

    return () => {
      cancelled = true
      mutationQueueRef.current = null
    }
  }, [formId, accountKey, userId])

  function handleMutationError(error: unknown) {
    if (error instanceof ApiClientError && error.code === "conflict") {
      setConflictOpen(true)
      setError(t("formPage.conflict"))
      return
    }
    // The only limit a form edit can hit: reopening a form while the owner
    // already has as many open forms as their plan allows.
    if (error instanceof ApiClientError && error.code === "rate_limited") {
      setError(t("formPage.openFormsLimit"))
      return
    }
    setError(t("formPage.saveFailed"))
  }

  async function saveFormPatch(patch: Record<string, unknown>) {
    const queue = mutationQueueRef.current
    if (queue === null) throw new Error("Form access is not ready")
    await queue.enqueue(patch)
  }

  /*
   * Both go through the mutation queue rather than a direct PATCH. The queue
   * owns the version this page holds, and a write around it would leave that
   * number stale, so the next ordinary save would come back a conflict the
   * user could not explain.
   */
  async function uploadHeaderImage(file: File) {
    if (!formDataKey) return
    if (file.size > MAX_HEADER_IMAGE_BYTES) {
      setHeaderImageError(t("formPage.imageTooLarge"))
      return
    }
    setHeaderImageBusy(true)
    setHeaderImageError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Encrypted with the schema key, not sealed to the form public key the
      // way a response attachment is: every respondent has to open this one,
      // and none of them holds the matching private key.
      const sealed = encryptBytesWithKey(bytes, formDataKey)
      const { attachment_id } = await apiUploadBytes<{ attachment_id: string }>(
        `/forms/${formId}/attachments`,
        sealed
      )
      await saveFormPatch({ header_attachment_id: attachment_id })
      setHasHeaderImage(true)
    } catch {
      setHeaderImageError(t("formPage.uploadFailed"))
    } finally {
      setHeaderImageBusy(false)
    }
  }

  async function removeHeaderImage() {
    setHeaderImageBusy(true)
    setHeaderImageError(null)
    try {
      await saveFormPatch({ header_attachment_id: null })
      setHasHeaderImage(false)
    } catch {
      setHeaderImageError(t("formPage.removeImageFailed"))
    } finally {
      setHeaderImageBusy(false)
    }
  }

  // Overrides carry a value whose state update has not rendered yet, so a
  // setting saves what was just chosen rather than what was on screen before.
  async function saveEncryptedDraft(
    overrides: { settings?: FormSettings; answerKey?: AnswerKey } = {}
  ) {
    if (!formDataKey || !formPrivateKey) {
      throw new Error("Form access is not ready")
    }
    const nextAnswerKey = overrides.answerKey ?? answerKey
    const schema: FormSchema = {
      questions,
      theme,
      settings: overrides.settings ?? settings,
      // From the private key this member holds, never from the public key
      // the server serves: committing to the served one would bless a key
      // someone had already swapped in the database.
      publicKeyCommitment: formKeyCommitment(
        sealPublicKeyFromPrivate(formPrivateKey)
      ),
    }
    await saveFormPatch({
      title_ciphertext: encryptWithKey(title, formDataKey),
      schema_ciphertext: encryptWithKey(JSON.stringify(schema), formDataKey),
      allow_response_editing: allowResponseEditing,
      // Same write, same version as the questions it describes. Omitted when
      // the form has no key, which leaves the stored one untouched.
      ...(nextAnswerKey
        ? {
            answer_key_ciphertext: sealAnswerKey(
              reconcileAnswerKey(questions, nextAnswerKey),
              formPrivateKey
            ),
          }
        : {}),
    })
  }

  async function handleSaveClick() {
    setSaving(true)
    setError(null)
    try {
      await saveEncryptedDraft()
      toast.add({ title: t("formPage.changesSaved"), type: "success" })
    } catch (error) {
      handleMutationError(error)
      if (!(error instanceof ApiClientError && error.code === "conflict")) {
        toast.add({
          title: t("formPage.saveChangesFailed"),
          description: t("common.genericError"),
          type: "error",
        })
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleAllowResponseEditingChange(value: boolean) {
    setAllowResponseEditing(value)
    setError(null)
    try {
      await saveFormPatch({ allow_response_editing: value })
    } catch (error) {
      if (!(error instanceof ApiClientError && error.code === "conflict")) {
        setAllowResponseEditing(!value)
      }
      handleMutationError(error)
    }
  }

  async function handleAcceptingResponsesChange(value: boolean) {
    setAcceptingResponses(value)
    setError(null)
    try {
      await saveFormPatch({ accepting_responses: value })
    } catch (error) {
      if (!(error instanceof ApiClientError && error.code === "conflict")) {
        setAcceptingResponses(!value)
      }
      handleMutationError(error)
    }
  }

  async function handleClosesAtChange(value: string | null) {
    const previous = closesAt
    setClosesAt(value)
    setError(null)
    try {
      await saveFormPatch({ closes_at: value })
    } catch (error) {
      if (!(error instanceof ApiClientError && error.code === "conflict")) {
        setClosesAt(previous)
      }
      handleMutationError(error)
    }
  }

  async function handleMaxResponsesChange(value: number | null) {
    const previous = maxResponses
    setMaxResponses(value)
    setError(null)
    try {
      await saveFormPatch({ max_responses: value })
    } catch (error) {
      if (!(error instanceof ApiClientError && error.code === "conflict")) {
        setMaxResponses(previous)
      }
      handleMutationError(error)
    }
  }

  async function handleNotifyOnResponseChange(value: boolean) {
    const previous = notifyOnResponse
    setNotifyOnResponse(value)
    try {
      await apiFetch(`/forms/${formId}/members/me`, {
        method: "PATCH",
        body: JSON.stringify({ notify_on_response: value }),
      })
    } catch {
      setNotifyOnResponse(previous)
      toast.add({
        title: t("formPage.notifyFailed"),
        description: t("common.genericError"),
        type: "error",
      })
    }
  }

  async function handleSettingsChange(next: FormSettings) {
    const previous = settings
    setSettings(next)
    try {
      await saveEncryptedDraft({ settings: next })
    } catch (error) {
      if (!(error instanceof ApiClientError && error.code === "conflict")) {
        setSettings(previous)
      }
      handleMutationError(error)
    }
  }

  // Off keeps the key rather than dropping it, so switching back on loses
  // nothing the creator had marked. Saved at once, like every other setting.
  async function handleQuizEnabledChange(enabled: boolean) {
    const previous = answerKey
    const next: AnswerKey = previous
      ? { ...previous, enabled }
      : { enabled, questions: {} }
    setAnswerKey(next)
    try {
      await saveEncryptedDraft({ answerKey: next })
    } catch (error) {
      if (!(error instanceof ApiClientError && error.code === "conflict")) {
        setAnswerKey(previous)
      }
      handleMutationError(error)
    }
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(
        serializeDraftForClipboard({ title, questions, theme, settings })
      )
      toast.add({ title: t("formPage.draftCopied"), type: "success" })
    } catch {
      toast.add({
        title: t("formPage.draftCopyFailed"),
        description: t("formPage.draftCopyFailedBody"),
        type: "error",
      })
    }
  }

  async function deleteForm() {
    await apiFetch<Record<string, never>>(`/forms/${formId}`, {
      method: "DELETE",
    })
    router.replace("/dashboard")
  }

  async function downloadAttachment(file: FileAnswer) {
    if (!formPrivateKey) return
    setDownloadErrors((prev) => {
      const next = { ...prev }
      delete next[file.attachmentId]
      return next
    })
    try {
      const sealed = await apiDownloadBytes(
        `/forms/${formId}/attachments/${file.attachmentId}`
      )
      const plaintext = unsealBoxBytes(sealed, formPrivateKey)
      const blob = new Blob([new Uint8Array(plaintext)], {
        type: file.mimeType,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = file.filename
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setDownloadErrors((prev) => ({
        ...prev,
        [file.attachmentId]: t("formPage.decryptFileFailed"),
      }))
    }
  }

  async function handleDeleteResponse(response: {
    id: string
    answers: Record<string, AnswerValue>
  }) {
    // The server cannot see which attachments this response referenced,
    // because that link lives inside the ciphertext it has no key for. So send them.
    const attachmentIds = attachmentIdsOf(response.answers)

    const previous = responses
    setResponses((current) => current.filter((r) => r.id !== response.id))
    try {
      await apiFetch(`/forms/${formId}/responses/${response.id}`, {
        method: "DELETE",
        body: JSON.stringify({ attachment_ids: attachmentIds }),
      })
      void quiz.removeResponse(response.id)
    } catch (error) {
      // The endpoint isn't idempotent: a retry after the delete already
      // committed gets a 404 because the row is genuinely gone. That is the
      // outcome the user asked for, not a failure to roll back. An
      // attachment id the server rejects (e.g. belonging to another form) is
      // a distinct case and comes back as `bad_request`, not `not_found`, so
      // `not_found` here means only "already gone" and must not be broadened
      // back into swallowing a real rejection.
      if (error instanceof ApiClientError && error.code === "not_found") {
        void quiz.removeResponse(response.id)
        return
      }
      setResponses(previous)
      toast.add({
        title: t("formPage.deleteResponseFailed"),
        description: t("common.genericError"),
        type: "error",
      })
    }
  }

  // Exports what is on screen, so a search narrows the file too. The
  // alternative, always exporting everything, silently hands over rows the
  // owner had just filtered out. The responses tab says which of the two is
  // happening rather than leaving it to be discovered in the file.
  function exportCsv() {
    const scoreHeaders =
      quizOn && answerKey
        ? [
            csvCell(t("formPage.score")),
            csvCell(t("formPage.csvPoints")),
            csvCell(t("formPage.csvToGrade")),
          ]
        : []
    const headers = [...questions.map((q) => csvCell(q.label)), ...scoreHeaders]
    const rows = responseMatches.map(({ response: r }) => {
      const cells = questions.map((q) => csvCell(formatAnswer(r.answers[q.id])))
      if (quizOn && answerKey) {
        const score = scoreResponse(
          questions,
          answerKey,
          r.answers,
          marksFor(quiz.grades, r.id)
        )
        cells.push(
          csvCell(String(score.earned)),
          csvCell(String(score.possible)),
          csvCell(String(score.pending))
        )
      }
      return cells.join(",")
    })
    const csv = csvDocument(headers, rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${title || t("formPage.csvFallbackName")}-responses.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Searching filters here in the render body rather than behind a useMemo:
  // manual memoisation the React Compiler cannot preserve is a lint error in
  // this project, and the work is a string join per response per keystroke.
  // The query never leaves the browser; `lib/response-search.ts` says why it
  // cannot.
  const responseMatches = filterResponses(questions, responses, responseQuery)
  const responseSearchActive = searchTerms(responseQuery).length > 0

  const quizOn = answerKey?.enabled === true
  const gradingTarget =
    gradingId === null
      ? null
      : (responseMatches.find((match) => match.response.id === gradingId) ??
        null)
  // A search that hides the response being graded already keeps the dialog
  // closed below (it renders only when `gradingTarget` is truthy), but
  // `gradingId` itself would otherwise sit in state, so clearing the search
  // reopens the same dialog. Adjusted here, in the render body, rather than
  // in an effect: React's documented pattern for state derived from a prop
  // change, and calling a state setter synchronously inside an effect body
  // is this project's lint error.
  if (gradingId !== null && gradingTarget === null) {
    setGradingId(null)
  }
  const nextToGrade =
    quizOn && answerKey && gradingTarget
      ? nextResponseToGrade(
          questions,
          answerKey,
          responseMatches.map((match) => match.response),
          quiz.grades,
          gradingTarget.response.id
        )
      : null

  // Rebuilt from the unwrapped data key rather than read from the creation
  // fragment, so the link stays available on reloads and after saving. The key
  // lives in the fragment, which browsers never send to the server.
  const shareLink =
    formDataKey === null || typeof window === "undefined"
      ? null
      : `${window.location.origin}/f/${formId}#key=${encodeURIComponent(formDataKey)}`

  async function copyShareLink() {
    if (shareLink === null) return
    try {
      await navigator.clipboard.writeText(shareLink)
      toast.add({ title: t("formPage.linkCopied"), type: "success" })
    } catch {
      // The clipboard API needs a secure context and can be denied by policy.
      toast.add({
        title: t("formPage.linkCopyFailed"),
        description: t("formPage.linkCopyFailedBody"),
        type: "error",
      })
    }
  }

  const loadedForCurrentForm =
    userId !== null &&
    loadIdentity?.formId === formId &&
    loadIdentity.userId === userId

  if (!loadedForCurrentForm) return <FullPageSpinner />
  if (loadIdentity.status === "error")
    return (
      <WorkspaceUnavailable
        failure={loadFailure ?? describeWorkspaceLoadFailure(null)}
      />
    )

  const canEdit = formRole === "owner" || formRole === "editor"

  return (
    <>
      <ConflictDialog
        open={conflictOpen}
        onOpenChange={setConflictOpen}
        onCopyDraft={copyDraft}
        onReloadLatest={() => window.location.reload()}
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
        <div className="flex h-svh flex-col overflow-hidden">
          <div className="shrink-0">
            <AppHeader
              formName={title}
              actions={
                <>
                  {tab === "questions" && (
                    <PreviewButton onClick={() => setPreviewOpen(true)} />
                  )}
                  {formRole === "owner" &&
                    formDataKey !== null &&
                    formPrivateKey !== null && (
                      <SharingDialog
                        formId={formId}
                        formDataKey={formDataKey}
                        formPrivateKey={formPrivateKey}
                        onOwnershipTransferred={() => setFormRole("editor")}
                      />
                    )}
                  {shareLink !== null && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={copyShareLink}
                      aria-label={t("formPage.copyLink")}
                      className="transition-transform duration-150 ease-out active:scale-[0.97] max-sm:w-7 max-sm:px-0!"
                    >
                      <HugeiconsIcon icon={Link01Icon} size={15} />
                      <span className="hidden sm:inline">
                        {t("formPage.copyLink")}
                      </span>
                    </Button>
                  )}
                  {tab === "questions" && canEdit ? (
                    <Button
                      size="sm"
                      onClick={handleSaveClick}
                      disabled={saving || !title}
                      className="transition-transform duration-150 ease-out active:scale-[0.97]"
                    >
                      <HugeiconsIcon
                        icon={saving ? Loading03Icon : CheckmarkCircle02Icon}
                        size={15}
                        className={saving ? "animate-spin" : undefined}
                        data-icon="inline-start"
                      />
                      {saving ? (
                        /*
                         * The resting label is reserved behind the pending
                         * one, so the button keeps its width while saving.
                         * Swapping the text outright made it shrink and snap
                         * back, which on a fast connection reads as a glitch.
                         * Same grid overlay the instance settings save button
                         * uses.
                         */
                        <span className="grid *:col-start-1 *:row-start-1">
                          <span className="invisible">
                            <span className="sm:hidden">
                              {t("common.save")}
                            </span>
                            <span className="hidden sm:inline">
                              {t("formPage.saveChanges")}
                            </span>
                          </span>
                          <span>{t("common.saving")}</span>
                        </span>
                      ) : (
                        <>
                          <span className="sm:hidden">{t("common.save")}</span>
                          <span className="hidden sm:inline">
                            {t("formPage.saveChanges")}
                          </span>
                        </>
                      )}
                    </Button>
                  ) : tab === "responses" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={exportCsv}
                      disabled={responseMatches.length === 0}
                      aria-label={
                        responseSearchActive
                          ? t("formPage.exportMatching", {
                              count: responseMatches.length,
                            })
                          : t("formPage.exportCsv")
                      }
                      className="transition-transform duration-150 ease-out active:scale-[0.97] max-sm:w-7 max-sm:px-0!"
                    >
                      <HugeiconsIcon
                        icon={FileExportIcon}
                        size={15}
                        data-icon="inline-start"
                      />
                      <span className="hidden sm:inline">
                        {t("formPage.exportCsv")}
                      </span>
                    </Button>
                  ) : null}
                </>
              }
            />
            <div className="bg-background/85 backdrop-blur-sm">
              <div className="mx-auto w-full max-w-7xl px-4">
                <TabsList className="justify-center">
                  <TabsTrigger value="questions">
                    {t("tabs.questions")}
                  </TabsTrigger>
                  <TabsTrigger value="responses">
                    {t("tabs.responses")}
                  </TabsTrigger>
                  <TabsTrigger value="settings">
                    {t("tabs.settings")}
                  </TabsTrigger>
                  <TabsIndicator />
                </TabsList>
              </div>
            </div>
          </div>
          {error && title && (
            <p
              className="mx-auto mt-4 w-full max-w-7xl px-4 text-sm text-destructive"
              aria-live="polite"
            >
              {error}
            </p>
          )}
          <TabsContent
            value="questions"
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            {canEdit ? (
              <FormBuilder
                eyebrowLabel={t("formPage.editingForm")}
                title={title}
                onTitleChange={setTitle}
                questions={questions}
                onQuestionsChange={setQuestions}
                theme={theme}
                onThemeChange={setTheme}
                answerKey={answerKey}
                onAnswerKeyChange={setAnswerKey}
                headerImage={{
                  previewUrl: headerImageUrl,
                  busy: headerImageBusy,
                  error: headerImageError,
                  onSelect: (file) => void uploadHeaderImage(file),
                  onRemove: () => void removeHeaderImage(),
                }}
                previewOpen={previewOpen}
                onPreviewOpenChange={setPreviewOpen}
              />
            ) : (
              <FormThemeSurface
                // A member's view inside the app, so the app's language.
                applyLanguage={false}
                theme={theme}
                mode="light"
                className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8"
              >
                <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  {t("formPage.viewingForm")}
                </p>
                <fieldset
                  disabled
                  aria-label={t("formPage.readOnlyLabel")}
                  className="space-y-4"
                >
                  <FormHeaderCard
                    title={title}
                    headerImageUrl={headerImageUrl}
                  />
                  {questions.map((q) => (
                    <FormQuestionCard
                      key={q.id}
                      question={q}
                      value={undefined}
                      onAnswerChange={() => undefined}
                      onToggleCheckbox={() => undefined}
                      onFileSelect={() => undefined}
                      uploading={false}
                      uploadError={undefined}
                    />
                  ))}
                </fieldset>
              </FormThemeSurface>
            )}
          </TabsContent>
          <TabsContent
            value="responses"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto w-full max-w-3xl flex-1 p-4">
              <h2
                className="mb-4 text-sm font-medium text-muted-foreground"
                aria-live="polite"
              >
                {responseSearchActive
                  ? t("formPage.responseMatches", {
                      matches: responseMatches.length,
                      total: responses.length,
                    })
                  : t("formPage.responseCount", { count: responses.length })}
              </h2>
              {unreadableResponses > 0 && (
                <p className="mb-4 text-sm text-destructive">
                  {t("formPage.unreadable", { count: unreadableResponses })}
                </p>
              )}
              {quizOn && quiz.unreadable && (
                <p className="mb-4 text-xs text-destructive">
                  {t("formPage.gradesUnreadable")}
                </p>
              )}
              {quizOn && quiz.conflict && (
                <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                  <p>{t("formPage.gradeConflict")}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={quiz.dismissConflict}
                  >
                    {t("formPage.dismiss")}
                  </Button>
                </div>
              )}
              {responses.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in">
                  <p className="text-sm text-muted-foreground">
                    {t("formPage.noResponses")}
                  </p>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant={
                          responseView === "summary" ? "default" : "outline"
                        }
                        size="sm"
                        onClick={() => setResponseView("summary")}
                      >
                        {t("formPage.summary")}
                      </Button>
                      <Button
                        type="button"
                        variant={
                          responseView === "individual" ? "default" : "outline"
                        }
                        size="sm"
                        onClick={() => setResponseView("individual")}
                      >
                        {t("formPage.individual")}
                      </Button>
                    </div>
                    <div className="relative sm:ms-auto sm:w-64">
                      <HugeiconsIcon
                        icon={Search01Icon}
                        size={14}
                        className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                      />
                      <Input
                        type="search"
                        value={responseQuery}
                        onChange={(event) =>
                          setResponseQuery(event.target.value)
                        }
                        placeholder={t("formPage.searchPlaceholder")}
                        aria-label={t("formPage.searchLabel")}
                        className="ps-8"
                      />
                    </div>
                  </div>
                  {responseSearchActive && responseMatches.length > 0 && (
                    <p className="mb-4 text-xs text-muted-foreground">
                      {t("formPage.searchNote", {
                        count: responseMatches.length,
                      })}
                    </p>
                  )}
                  {responseMatches.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in">
                      <p className="text-sm text-muted-foreground">
                        {t("formPage.noMatches")}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        onClick={() => setResponseQuery("")}
                      >
                        {t("formPage.clearSearch")}
                      </Button>
                    </div>
                  ) : responseView === "summary" ? (
                    <>
                      {quizOn && answerKey && (
                        <QuizSummary
                          questions={questions}
                          answerKey={answerKey}
                          responses={responseMatches.map((m) => m.response)}
                          grades={quiz.grades}
                        />
                      )}
                      <ResponseSummaryLazy
                        questions={questions}
                        responses={responseMatches.map(
                          (m) => m.response.answers
                        )}
                      />
                    </>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-border">
                      <div className="max-h-[28rem] overflow-auto overscroll-contain">
                        <table className="w-full border-collapse text-sm">
                          <thead className="sticky top-0 z-10 bg-background/85 backdrop-blur-sm">
                            <tr>
                              <th className="w-10 border-b border-border px-3 py-2.5 text-start text-xs font-medium tracking-wider text-muted-foreground uppercase">
                                #
                              </th>
                              {quizOn && (
                                <th className="border-b border-border px-3 py-2.5 text-start text-xs font-medium tracking-wider text-muted-foreground uppercase">
                                  {t("formPage.score")}
                                </th>
                              )}
                              {questions.map((q) => (
                                <th
                                  key={q.id}
                                  dir="auto"
                                  className="border-b border-border px-3 py-2.5 text-start text-xs font-medium tracking-wider text-muted-foreground uppercase"
                                >
                                  {q.label}
                                </th>
                              ))}
                              {canEdit && (
                                <th className="w-10 border-b border-border px-3 py-2.5">
                                  <span className="sr-only">
                                    {t("formPage.actions")}
                                  </span>
                                </th>
                              )}
                            </tr>
                          </thead>
                          <tbody className="[&>tr:last-child>td]:border-0">
                            {responseMatches.map(
                              ({ response: r, position }, i) => (
                                <tr
                                  key={r.id}
                                  className="animate-list-item-in transition-colors duration-150 ease-out hover:bg-muted/40"
                                  style={{
                                    animationDelay: `${Math.min(i, 10) * 40}ms`,
                                  }}
                                >
                                  <td className="border-b border-border px-3 py-2.5 font-mono text-xs text-muted-foreground">
                                    {position}
                                  </td>
                                  {quizOn && answerKey && (
                                    <ScoreCell
                                      position={position}
                                      questions={questions}
                                      answerKey={answerKey}
                                      answers={r.answers}
                                      marks={marksFor(quiz.grades, r.id)}
                                      onOpen={() => setGradingId(r.id)}
                                    />
                                  )}
                                  {questions.map((q) => (
                                    <td
                                      key={q.id}
                                      dir="auto"
                                      className="border-b border-border px-3 py-2.5"
                                    >
                                      {isFileAnswer(r.answers[q.id]) ? (
                                        <>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              downloadAttachment(
                                                r.answers[q.id] as FileAnswer
                                              )
                                            }
                                            className="inline-flex items-center gap-1 text-primary underline underline-offset-4 transition-opacity duration-150 ease-out hover:opacity-70"
                                          >
                                            <HugeiconsIcon
                                              icon={Download04Icon}
                                              size={13}
                                            />
                                            {
                                              (r.answers[q.id] as FileAnswer)
                                                .filename
                                            }
                                          </button>
                                          {downloadErrors[
                                            (r.answers[q.id] as FileAnswer)
                                              .attachmentId
                                          ] && (
                                            <p className="mt-1 text-xs text-destructive">
                                              {
                                                downloadErrors[
                                                  (
                                                    r.answers[
                                                      q.id
                                                    ] as FileAnswer
                                                  ).attachmentId
                                                ]
                                              }
                                            </p>
                                          )}
                                        </>
                                      ) : (
                                        formatAnswer(r.answers[q.id])
                                      )}
                                    </td>
                                  ))}
                                  {canEdit && (
                                    <td className="border-b border-border px-3 py-2.5 text-end">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={t(
                                          "formPage.deleteResponseAria",
                                          { position }
                                        )}
                                        onClick={() => setDeleteTarget(r)}
                                      >
                                        <HugeiconsIcon
                                          icon={Delete02Icon}
                                          size={14}
                                        />
                                      </Button>
                                    </td>
                                  )}
                                </tr>
                              )
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            {quizOn && answerKey && gradingTarget && (
              <GradeResponseDialog
                onClose={() => setGradingId(null)}
                position={gradingTarget.position}
                questions={questions}
                answerKey={answerKey}
                answers={gradingTarget.response.answers}
                marks={marksFor(quiz.grades, gradingTarget.response.id)}
                canGrade={canEdit && quiz.ready}
                onMark={(questionId, mark) =>
                  void quiz.setMark(gradingTarget.response.id, questionId, mark)
                }
                onNext={nextToGrade ? () => setGradingId(nextToGrade) : null}
                conflict={quiz.conflict}
                onDismissConflict={quiz.dismissConflict}
              />
            )}
            <Dialog
              open={deleteTarget !== null}
              onOpenChange={(open) => {
                if (!open) setDeleteTarget(null)
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("formPage.deleteTitle")}</DialogTitle>
                  <DialogDescription>
                    {[
                      t("formPage.deleteBody"),
                      deleteTarget !== null &&
                        Object.values(deleteTarget.answers).some(
                          isFileAnswer
                        ) &&
                        t("formPage.deleteFiles"),
                      maxResponses !== null && t("formPage.deleteLimit"),
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" size="sm" />}>
                    {t("common.cancel")}
                  </DialogClose>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      if (deleteTarget !== null) {
                        void handleDeleteResponse(deleteTarget)
                      }
                      setDeleteTarget(null)
                    }}
                  >
                    {t("formPage.deleteConfirm")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </TabsContent>
          <TabsContent
            value="settings"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <FormSettingsPanel
              settings={settings}
              onSettingsChange={handleSettingsChange}
              allowResponseEditing={allowResponseEditing}
              onAllowResponseEditingChange={handleAllowResponseEditingChange}
              acceptingResponses={acceptingResponses}
              onAcceptingResponsesChange={handleAcceptingResponsesChange}
              notifyOnResponse={notifyOnResponse}
              onNotifyOnResponseChange={handleNotifyOnResponseChange}
              closesAt={closesAt}
              onClosesAtChange={handleClosesAtChange}
              maxResponses={maxResponses}
              onMaxResponsesChange={handleMaxResponsesChange}
              quizEnabled={answerKey?.enabled === true}
              onQuizEnabledChange={handleQuizEnabledChange}
              canEdit={canEdit}
              isOwner={formRole === "owner"}
              onDelete={deleteForm}
            />
          </TabsContent>
        </div>
      </Tabs>
    </>
  )
}
