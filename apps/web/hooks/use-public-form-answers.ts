import { useCallback, useEffect, useRef, useState } from "react"
import { sealBoxBytes, type Question } from "@krypta/crypto"
import { apiUploadBytes } from "@/lib/api"
import {
  clearDraft,
  loadDraft,
  saveDraft,
  sweepExpiredDrafts,
} from "../lib/form-draft"
import {
  isAnswerEmpty,
  reconcileDraft,
  type AnswerValue,
} from "../lib/form-answers"

const MAX_FILE_BYTES = 10 * 1024 * 1024

/*
 * A keystroke is a state change, and localStorage writes synchronously on the
 * main thread. Writing per character would put a JSON serialisation of every
 * answer between the key and the glyph on a slow phone, so the save trails the
 * typing instead.
 */
const DRAFT_SAVE_DEBOUNCE_MS = 400

/*
 * A shared empty list, so a caller that passes no questions hands the same
 * identity every render rather than a fresh array that would re-run the
 * reconcile effect below on every keystroke.
 */
const NO_QUESTIONS: Question[] = []

/*
 * Re-exported rather than declared: `lib/form-answers.ts` owns these, and its
 * own header says why there must not be a second definition to drift from it.
 */
export type { AnswerValue, FileAnswer } from "../lib/form-answers"

/**
 * @param persistDraft Keep the answers on this device so the respondent can
 *   close the tab and come back. Off by default, and deliberately: the public
 *   fill page opts in, while the edit-response page does not, because it does
 *   not prefill the submitted response either and a local draft there would
 *   silently disagree with what the server holds.
 * @param questions The form's questions, empty until they have been fetched and
 *   decrypted. A restored draft is judged against them the moment they arrive.
 *   Passed in rather than exposing a setter for the answers: this hook owns
 *   them, so it owns the correction to them, and a call site cannot forget to
 *   ask for one.
 */
export function usePublicFormAnswers(
  formId: string,
  publicKey: string | null,
  persistDraft = false,
  questions: Question[] = NO_QUESTIONS
) {
  /*
   * Restored during the first render rather than in an effect, so the fields
   * are already filled on the first paint. Arriving empty and then populating
   * would show the respondent an empty form for a frame, which reads as lost
   * work, and it would let the autosave below write that empty state over the
   * draft it is about to read.
   */
  const [restored] = useState(() => {
    if (!persistDraft) return null
    sweepExpiredDrafts()
    return loadDraft(formId)
  })
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(
    () => restored ?? {}
  )
  /*
   * Whether there is a draft on this device right now, tracked from what the
   * writes actually did rather than from what the form currently holds. The
   * notice built on this tells a respondent their answers are saved here, and
   * that claim is false whenever storage is blocked, during the debounce window
   * before the first write, and when the only answer is an empty string.
   */
  const [draftSaved, setDraftSaved] = useState(() => restored !== null)
  const [staleAnswersDropped, setStaleAnswersDropped] = useState(false)
  const [uploadingIds, setUploadingIds] = useState<Set<string>>(new Set())
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestAnswers = useRef(answers)

  useEffect(() => {
    // Kept current here rather than during render, which the hook rules forbid.
    // Effects have flushed by the time any event below can fire.
    latestAnswers.current = answers
    if (!persistDraft) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      setDraftSaved(saveDraft(formId, answers))
    }, DRAFT_SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [answers, formId, persistDraft])

  /*
   * A debounce that drops its pending write when the page goes away is a
   * debounce that loses work, and it loses it from exactly the moment a
   * respondent is most likely to leave: right after typing. Closing a tab does
   * not unmount React either, so an unmount-only flush would not see it at all.
   *
   * `pagehide` is the event that actually fires for a close, a reload, a
   * navigation and a move into the back/forward cache; `visibilitychange`
   * catches a mobile browser being backgrounded, which on iOS may never fire
   * `pagehide` at all. Both are idempotent here, so firing both costs one
   * redundant write.
   *
   * The dependencies are primitives, so this registers once rather than
   * re-registering on every keystroke; the answers it writes come from a ref
   * that the render above keeps current.
   */
  useEffect(() => {
    if (!persistDraft) return
    function flush() {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      setDraftSaved(saveDraft(formId, latestAnswers.current))
    }
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") flush()
    }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      flush()
    }
  }, [formId, persistDraft])

  /*
   * A restored draft is only meaningful against the schema it was typed into,
   * and the schema arrives second: the answers are read during the first
   * render, while the questions are still being fetched and decrypted. So the
   * draft is judged here, the moment they land, rather than at read time.
   *
   * Restoring in the initializer is what makes that split necessary and it is
   * not negotiable: an effect would paint an empty form for a frame, which
   * reads as lost work, and the autosave would write that empty state over the
   * draft it was about to read.
   *
   * Safe to run more than once. `reconcileDraft` hands back the same object
   * when it drops nothing, so a second pass over an already-reconciled set
   * returns here without a render or a write.
   */
  useEffect(() => {
    if (!persistDraft || questions.length === 0) return
    const current = latestAnswers.current
    const reconciled = reconcileDraft(questions, current)
    if (reconciled === current) return
    latestAnswers.current = reconciled
    setAnswers(reconciled)
    setStaleAnswersDropped(true)
  }, [persistDraft, questions])

  /**
   * Throws the saved answers away and empties the form with them.
   *
   * Emptying the answers is not a courtesy, it is what makes the discard
   * stick. Clearing storage while leaving the fields populated would write the
   * draft straight back on the next keystroke, and again when the page is left,
   * since the flush below writes whatever the form currently holds. With the
   * answers empty every one of those paths writes nothing.
   *
   * That is also why the submit path calls this rather than reaching for
   * `clearDraft` directly: leaving the answers in memory meant navigating away
   * from the confirmation screen restored the draft of a response that had
   * already been sent.
   */
  const discardDraft = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    latestAnswers.current = {}
    clearDraft(formId)
    setAnswers({})
    setUploadErrors({})
    setDraftSaved(false)
    setStaleAnswersDropped(false)
  }, [formId])

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

  async function handleFileSelect(qid: string, file: File | undefined) {
    if (!file || !publicKey) return
    setUploadErrors((prev) => {
      const next = { ...prev }
      delete next[qid]
      return next
    })
    if (file.size > MAX_FILE_BYTES) {
      setUploadErrors((prev) => ({
        ...prev,
        // A message key, worded in the form's language by the field.
        [qid]: "fileTooLarge",
      }))
      setAnswers((a) => {
        const next = { ...a }
        delete next[qid]
        return next
      })
      return
    }
    setUploadingIds((prev) => new Set(prev).add(qid))
    try {
      const buffer = await file.arrayBuffer()
      const sealed = sealBoxBytes(new Uint8Array(buffer), publicKey)
      const { attachment_id } = await apiUploadBytes<{ attachment_id: string }>(
        `/forms/${formId}/attachments`,
        sealed
      )
      setAnswers((a) => ({
        ...a,
        [qid]: {
          attachmentId: attachment_id,
          filename: file.name,
          mimeType: file.type,
          size: file.size,
        },
      }))
    } catch {
      setUploadErrors((prev) => ({
        ...prev,
        [qid]: "uploadFailed",
      }))
      setAnswers((a) => {
        const next = { ...a }
        delete next[qid]
        return next
      })
    } finally {
      setUploadingIds((prev) => {
        const next = new Set(prev)
        next.delete(qid)
        return next
      })
    }
  }

  function missingRequired(shown: Question[]): boolean {
    return shown.some((q) => q.required && isAnswerEmpty(answers[q.id]))
  }

  return {
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
  }
}
