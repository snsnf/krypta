"use client"

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"
import { ApiClientError, apiFetch } from "@/lib/api"
import { toast } from "@/components/ui/toast"
import { useAppT } from "@/lib/app-i18n"
import {
  EMPTY_GRADES,
  removeResponseMarks,
  setMark as withMark,
  type Grades,
} from "@/lib/quiz"
import { openGrades, sealGrades } from "@/lib/quiz-sealing"

interface GradesState {
  formId: string
  grades: Grades
  version: number
  formPrivateKey: string | null
  unreadable: boolean
}

interface GradesSetters {
  setGrades: Dispatch<SetStateAction<Grades>>
  setUnreadable: Dispatch<SetStateAction<boolean>>
  setLoaded: Dispatch<SetStateAction<boolean>>
}

/**
 * Outside the hook on purpose: the load effect calls it, and a function
 * declared in the hook body would have to be an effect dependency, which is
 * recreated every render. Only ever called from inside an async callback
 * (after an `await`), never synchronously from the effect body, which is
 * what keeps every `setGrades`/`setUnreadable` call here clear of this
 * project's "no synchronous setState in an effect" lint rule.
 */
function applyLoaded(
  stateRef: { current: GradesState },
  setters: GradesSetters,
  grades: Grades | null,
  version: number,
  formId: string,
  formPrivateKey: string
) {
  stateRef.current = {
    formId,
    grades: grades ?? EMPTY_GRADES,
    version,
    formPrivateKey,
    unreadable: grades === null,
  }
  setters.setGrades(stateRef.current.grades)
  setters.setUnreadable(stateRef.current.unreadable)
  setters.setLoaded(true)
}

async function fetchGrades(formId: string, formPrivateKey: string) {
  const stored = await apiFetch<{ ciphertext: string | null; version: number }>(
    `/forms/${formId}/grades`
  )
  return {
    grades: openGrades(stored.ciphertext, formPrivateKey),
    version: stored.version,
  }
}

/**
 * A form's manual grades, loaded when the form is a quiz and saved one click
 * at a time.
 *
 * Every click PUTs the whole blob under the version it was read at. Writes are
 * chained, so two quick clicks never race each other. A 409 means someone else
 * graded in between: their grades are loaded and this click is not re-applied,
 * the same rule form edits follow, so nobody's mark is overwritten unseen.
 * Until the load finishes, and whenever the saved grades cannot be opened,
 * nothing is written.
 *
 * `stateRef` always names the form and key it belongs to
 * (`GradesState.formId`/`formPrivateKey`), and `write` reads both from it
 * rather than from this function's own arguments or from the closure a click
 * was made under. Navigating from one quiz form to another changes `formId`
 * and `formPrivateKey` on the next render, but a click already queued, or a
 * response delete already in flight, closed over the old values; without the
 * state object carrying its own identity and `write` comparing against it by
 * reference, that queued write would PUT the old form's grades, sealed under
 * the old form's key, at the new form's URL, or a click queued before a
 * mid-chain conflict would silently reapply itself to the grades that
 * conflict just loaded, which the user never saw.
 *
 * The visible `grades`/`unreadable`/`conflict` are reset the moment `formId`,
 * `formPrivateKey` or `active` changes, during render rather than inside the
 * effect below: calling a state setter synchronously in an effect body is a
 * lint error in this project (the React Compiler diagnostics treat it as a
 * cause of cascading renders), so the reset uses React's documented pattern
 * for adjusting state when a prop changes instead, comparing against the
 * previous key and calling the setters right there in the render body. That
 * still runs strictly before this effect's load starts, since render always
 * precedes it.
 */
export function useQuizGrades(
  formId: string,
  formPrivateKey: string | null,
  active: boolean
) {
  const t = useAppT()
  const key =
    active && formPrivateKey !== null ? `${formId}:${formPrivateKey}` : null

  const [grades, setGrades] = useState<Grades>(EMPTY_GRADES)
  const [unreadable, setUnreadable] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [resetKey, setResetKey] = useState(key)
  if (resetKey !== key) {
    setResetKey(key)
    setGrades(EMPTY_GRADES)
    setUnreadable(false)
    setConflict(false)
    setLoaded(false)
  }

  const stateRef = useRef<GradesState>({
    formId,
    grades: EMPTY_GRADES,
    version: 0,
    formPrivateKey: null,
    unreadable: false,
  })
  const chainRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    // Ref-only reset: mutating a ref triggers no render, so unlike a state
    // setter it carries no restriction on being synchronous here. This runs
    // unconditionally, before the `active`/key check, because a response
    // delete's `removeResponses` fires regardless of whether the form is a
    // quiz: without a reset here, deleting a response right after
    // navigating away from a quiz form could still PUT that quiz's grades
    // ciphertext at the new form's URL.
    const freshState: GradesState = {
      formId,
      grades: EMPTY_GRADES,
      version: 0,
      formPrivateKey: null,
      unreadable: false,
    }
    stateRef.current = freshState

    if (!active || formPrivateKey === null) return
    const setters = { setGrades, setUnreadable, setLoaded }
    let cancelled = false
    ;(async () => {
      try {
        const loaded = await fetchGrades(formId, formPrivateKey)
        if (cancelled || stateRef.current !== freshState) return
        applyLoaded(
          stateRef,
          setters,
          loaded.grades,
          loaded.version,
          formId,
          formPrivateKey
        )
      } catch {
        // Not knowing what is saved is treated like not being able to read
        // it: grading pauses rather than risk writing over it. This also
        // covers a transient network failure, not only unreadable
        // ciphertext, which is why the notice the page shows for this state
        // does not blame the data.
        if (!cancelled && stateRef.current === freshState) {
          applyLoaded(stateRef, setters, null, 0, formId, formPrivateKey)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [formId, formPrivateKey, active])

  function write(
    update: (current: Grades) => Grades,
    force = false
  ): Promise<void> {
    // Captured synchronously, before this click joins the chain. If the
    // state object has already changed by the time this click's turn comes
    // up (a reset from navigating away, or another queued click's conflict
    // recovery), this click was made against grades the user can no longer
    // see and must not apply, the same rule a conflict enforces for the
    // click that discovers it.
    const enqueuedState = stateRef.current
    chainRef.current = chainRef.current.then(async () => {
      if (stateRef.current !== enqueuedState) return
      const state = stateRef.current
      if (state.formPrivateKey === null || state.unreadable) return
      const { formId: stateFormId, formPrivateKey } = state
      const previous = state.grades
      const next = update(previous)
      // `force` exists for `removeResponses`: `removeResponseMarks` returns
      // the same object when none of the responses had marks, so skipping
      // the save on an unchanged object would leave the server showing a
      // deleted response as still graded. An ordinary mark
      // click still gets the short-circuit, since it never forces.
      if (next === previous && !force) return
      state.grades = next
      setGrades(next)
      try {
        const { version } = await apiFetch<{ version: number }>(
          `/forms/${stateFormId}/grades`,
          {
            method: "PUT",
            body: JSON.stringify({
              ciphertext: sealGrades(next, formPrivateKey),
              expected_version: state.version,
            }),
          }
        )
        // Superseded while the PUT was in flight: applying `version` to a
        // state object nothing points at any more would be a write nobody
        // can see and no future write can revert.
        if (stateRef.current !== state) return
        state.version = version
      } catch (error) {
        if (stateRef.current !== state) return
        if (error instanceof ApiClientError && error.code === "conflict") {
          const setters = { setGrades, setUnreadable, setLoaded }
          try {
            const loaded = await fetchGrades(stateFormId, formPrivateKey)
            if (stateRef.current !== state) return
            applyLoaded(
              stateRef,
              setters,
              loaded.grades,
              loaded.version,
              stateFormId,
              formPrivateKey
            )
          } catch {
            if (stateRef.current !== state) return
            applyLoaded(stateRef, setters, null, 0, stateFormId, formPrivateKey)
          }
          setConflict(true)
          return
        }
        state.grades = previous
        setGrades(previous)
        toast.add({
          title: t("quiz.gradeFailed"),
          description: t("common.genericError"),
          type: "error",
        })
      }
    })
    return chainRef.current
  }

  return {
    grades,
    unreadable,
    // True once the load effect has settled for the current form and key,
    // and the result was readable. Grading controls gate on this rather
    // than on `!unreadable` alone, because `unreadable` starts false and
    // only turns true once loading fails: gating on it by itself lets a
    // click land in the gap between mount and that first load finishing,
    // where a write would clobber whatever the fetch was about to bring
    // back.
    ready: loaded && !unreadable,
    conflict,
    dismissConflict: () => setConflict(false),
    setMark: (responseId: string, questionId: string, mark: boolean | null) =>
      write((current) => withMark(current, responseId, questionId, mark)),
    // Forced: `removeResponseMarks` returns the same object when no
    // response had marks, but the server still needs to see this save so a
    // deleted response never looks graded because its marks happened to be
    // empty. See the comment on `write`'s `force` parameter. One save for
    // the whole set, so a bulk delete is one grades write, not one per row.
    removeResponses: (responseIds: readonly string[]) =>
      write((current) => removeResponseMarks(current, responseIds), true),
  }
}
