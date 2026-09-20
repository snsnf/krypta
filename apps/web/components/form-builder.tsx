"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  AlertCircleIcon,
  Cancel01Icon,
  CircleIcon,
  Copy01Icon,
  Delete02Icon,
  DragDropHorizontalIcon,
  Moon02Icon,
  PlusSignIcon,
  SquareIcon,
  Sun02Icon,
} from "@hugeicons/core-free-icons"
import type { FormTheme, Question } from "@krypta/crypto"
import { cn } from "@/lib/utils"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { FormPreview } from "@/components/form-preview"
import { revealColorChange } from "@/components/theme-toggle"
import { usePrefersDark } from "@/hooks/use-prefers-dark"
import { FormHeaderCard } from "@/components/form-header-card"
import { FormThemeSurface } from "@/components/form-theme-surface"
import {
  AppearancePanel,
  type HeaderImageControls,
} from "@/components/appearance/appearance-panel"
import type { FormRenderMode } from "@/lib/form-theme"
import { useFormQuestions } from "@/hooks/use-form-questions"
import { Checkbox } from "@/components/ui/checkbox"
import { AnswerKeyEditor } from "@/components/quiz/answer-key-editor"
import { entryFor, renameOptionInKey, type AnswerKey } from "@/lib/quiz"
import { distinctOptions, hasDuplicateOptions } from "@/lib/question-options"

const QUESTION_TYPE_LABELS: Record<Question["type"], string> = {
  short_text: "Short answer",
  long_text: "Long answer",
  multiple_choice: "Multiple choice",
  checkboxes: "Checkboxes",
  dropdown: "Dropdown",
  number: "Number",
  email: "Email",
  date: "Date",
  file_upload: "File upload",
}

const ANSWER_PREVIEW_PLACEHOLDERS: Partial<Record<Question["type"], string>> = {
  short_text: "Short answer text",
  long_text: "Long answer text",
  number: "Number",
  email: "Email address",
  date: "Date",
}

const OPTION_BASED_TYPES: Question["type"][] = [
  "multiple_choice",
  "checkboxes",
  "dropdown",
]

const UNDERLINE_INPUT_CLASSES =
  "w-full border-0 border-b border-transparent bg-transparent px-0 py-1 outline-none transition-colors duration-150 ease-out placeholder:text-muted-foreground/60 focus:border-border"

const TYPE_SELECT_CLASSES =
  "h-8 w-40 shrink-0 rounded-lg border border-input bg-transparent px-2 transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

const CONDITION_SOURCE_TYPES = new Set([
  "multiple_choice",
  "dropdown",
  "checkboxes",
])

// How long the broken-condition ring stays up once it starts fading out.

/**
 * Only questions BEFORE this one, and only choice-like ones. Restricting the
 * offer to earlier questions is what makes dependency cycles impossible, and
 * exact-matching free text breaks silently on case and whitespace.
 */
function conditionSources(questions: Question[], index: number): Question[] {
  return questions
    .slice(0, index)
    .filter(
      (q) => CONDITION_SOURCE_TYPES.has(q.type) && (q.options?.length ?? 0) > 0
    )
}

interface FormBuilderProps {
  eyebrowLabel: string
  title: string
  onTitleChange: (title: string) => void
  questions: Question[]
  onQuestionsChange: (questions: Question[]) => void
  theme: FormTheme
  onThemeChange: (theme: FormTheme) => void
  /** Absent while the form has no id yet, so there is nowhere to store bytes. */
  headerImage?: HeaderImageControls | null
  /** The preview dialog is opened from the app header, so the page owns it. */
  previewOpen?: boolean
  onPreviewOpenChange?: (open: boolean) => void
  /** The form's answer key, null when it has never been a quiz. */
  answerKey?: AnswerKey | null
  /** Absent hides every quiz control. */
  onAnswerKeyChange?: (key: AnswerKey) => void
}

export function FormBuilder({
  eyebrowLabel,
  title,
  onTitleChange,
  questions,
  onQuestionsChange,
  theme,
  onThemeChange,
  headerImage = null,
  previewOpen = false,
  onPreviewOpenChange = () => {},
  answerKey = null,
  onAnswerKeyChange,
}: FormBuilderProps) {
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  // null follows the device, as the public form does until someone picks.
  const [editorMode, setEditorMode] = useState<FormRenderMode | null>(null)
  const prefersDark = usePrefersDark()
  const editorRenderMode: FormRenderMode = theme.allowDarkMode
    ? (editorMode ?? (prefersDark ? "dark" : "light"))
    : "light"

  const quizOn = answerKey?.enabled === true && onAnswerKeyChange !== undefined
  const [openKeyIds, setOpenKeyIds] = useState<ReadonlySet<string>>(new Set())

  function toggleKeyEditor(questionId: string) {
    setOpenKeyIds((current) => {
      const next = new Set(current)
      if (next.has(questionId)) next.delete(questionId)
      else next.add(questionId)
      return next
    })
  }

  const {
    addQuestion,
    duplicateQuestionById,
    updateQuestion,
    changeQuestionType,
    toggleSectionBreak,
    removeOption,
    removeQuestion,
    moveQuestionTo,
    removingIds,
    removingSectionIds,
    highlightedId,
    reorderMessage,
    registerCard,
    draggingId,
    handlePointerDown,
  } = useFormQuestions(questions, onQuestionsChange)

  const formEditor = (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
          {eyebrowLabel}
        </p>
        {theme.allowDarkMode && (
          // Labelled buttons rather than the icon switch, which is the app's
          // own theme control in the header: two identical switches on one
          // screen would leave it unclear which one changes what. The circular
          // reveal is kept, so the preview changes as smoothly as the app does.
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Editor color mode"
          >
            {(["light", "dark"] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={editorRenderMode === mode}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  revealColorChange(
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2,
                    () => setEditorMode(mode)
                  )
                }}
                className="form-theme-outline-button transition-transform duration-150 ease-out active:scale-[0.97]"
              >
                <HugeiconsIcon
                  icon={mode === "light" ? Sun02Icon : Moon02Icon}
                  size={14}
                  data-icon="inline-start"
                />
                {mode === "light" ? "Light" : "Dark"}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-4">
        <FormHeaderCard
          title={title}
          headerImageUrl={headerImage?.previewUrl ?? null}
          onTitleChange={onTitleChange}
        />

        {questions.map((q, i) => (
          <div key={q.id} ref={(node) => registerCard(q.id, node)}>
            {i > 0 && (theme.layout ?? "classic") !== "focus" && (
              <div className="py-2">
                {q.pageBreakBefore ? (
                  <div
                    className={cn(
                      "flex overflow-hidden rounded-xl border border-border bg-card",
                      removingSectionIds.has(q.id)
                        ? "animate-question-out"
                        : "animate-question-in"
                    )}
                  >
                    <div className="w-1 shrink-0 bg-[var(--form-accent)]" />
                    <div className="flex flex-1 items-start gap-3 p-4">
                      <div className="min-w-0 flex-1">
                        <p className="form-theme-accent-text text-[11px] font-medium tracking-wide uppercase">
                          Section{" "}
                          {questions
                            .slice(0, i + 1)
                            .filter((qq) => qq.pageBreakBefore).length + 1}
                        </p>
                        <input
                          type="text"
                          value={q.sectionTitle ?? ""}
                          onChange={(e) =>
                            updateQuestion(q.id, {
                              sectionTitle: e.target.value,
                            })
                          }
                          placeholder="Section title (optional)"
                          className={cn(
                            UNDERLINE_INPUT_CLASSES,
                            "form-theme-question"
                          )}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleSectionBreak(q.id)}
                        aria-label="Remove section break"
                        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={14} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={() => toggleSectionBreak(q.id)}
                      className="text-xs text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
                    >
                      + Add section break
                    </button>
                  </div>
                )}
              </div>
            )}
            <div
              className={cn(
                "group relative flex overflow-hidden rounded-xl border border-border bg-card transition-[color,background-color,border-color,box-shadow] duration-150 ease-out",
                removingIds.has(q.id)
                  ? "animate-question-out"
                  : "animate-question-in",
                draggingId === q.id && "question-card-dragging",
                highlightedId === q.id && "ring-2 ring-destructive/60"
              )}
            >
              <div className="w-1 shrink-0 bg-transparent transition-colors duration-150 ease-out group-focus-within:bg-[var(--form-accent)]" />
              <button
                type="button"
                aria-label={`Reorder question ${i + 1}`}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveQuestionTo(q.id, i - 1, true)
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveQuestionTo(q.id, i + 1, true)
                  }
                }}
                onPointerDown={(event) => handlePointerDown(q.id, event)}
                // Top centre, where a grip that moves the card up and down is
                // expected, so the content below it gets the card's full width.
                className="absolute top-0.5 left-1/2 z-10 flex -translate-x-1/2 cursor-grab touch-none items-center justify-center rounded-md px-3 py-1 text-muted-foreground transition-colors duration-150 ease-out focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              >
                <HugeiconsIcon icon={DragDropHorizontalIcon} size={16} />
              </button>
              <div className="flex-1 p-4 pt-7">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
                  <input
                    placeholder="Question"
                    aria-label="Question label"
                    value={q.label}
                    onChange={(e) =>
                      updateQuestion(q.id, { label: e.target.value })
                    }
                    className={cn(
                      UNDERLINE_INPUT_CLASSES,
                      "form-theme-question flex-1"
                    )}
                  />
                  <select
                    aria-label="Question type"
                    value={q.type}
                    onChange={(e) =>
                      changeQuestionType(
                        q.id,
                        e.target.value as Question["type"]
                      )
                    }
                    className={cn(
                      TYPE_SELECT_CLASSES,
                      "form-theme-text w-full sm:w-40"
                    )}
                  >
                    {(
                      Object.entries(QUESTION_TYPE_LABELS) as [
                        Question["type"],
                        string,
                      ][]
                    ).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                {ANSWER_PREVIEW_PLACEHOLDERS[q.type] && (
                  <input
                    disabled
                    aria-hidden="true"
                    tabIndex={-1}
                    placeholder={ANSWER_PREVIEW_PLACEHOLDERS[q.type]}
                    className={cn(
                      UNDERLINE_INPUT_CLASSES,
                      "form-theme-text mt-2 cursor-default disabled:opacity-100",
                      // Its own dashed underline, shorter than the card, so it
                      // reads as the answer field and the full-width rule below
                      // reads as the footer's divider rather than as this
                      // field's line. Long answers get the full width.
                      "border-dashed border-muted-foreground/30",
                      q.type === "long_text" ? "w-full" : "w-full max-w-xs"
                    )}
                  />
                )}

                {q.type === "file_upload" && (
                  <p className="form-theme-text mt-2 text-muted-foreground/60">
                    Attachment upload
                  </p>
                )}

                {OPTION_BASED_TYPES.includes(q.type) && (
                  <div className="mt-2 flex flex-col gap-1">
                    {(q.options ?? []).map((opt, i) => (
                      <div
                        key={i}
                        className="group/option flex items-center gap-2"
                      >
                        <HugeiconsIcon
                          icon={
                            q.type === "multiple_choice"
                              ? CircleIcon
                              : SquareIcon
                          }
                          size={16}
                          className="shrink-0 text-muted-foreground/50"
                        />
                        <input
                          placeholder={`Option ${i + 1}`}
                          aria-label={`Option ${i + 1}`}
                          value={opt}
                          onChange={(e) => {
                            const options = [...(q.options ?? [])]
                            options[i] = e.target.value
                            updateQuestion(q.id, { options })
                            // The key stores option text, so it follows the
                            // rename rather than silently losing its answer.
                            if (answerKey && onAnswerKeyChange) {
                              onAnswerKeyChange(
                                renameOptionInKey(
                                  answerKey,
                                  q.id,
                                  opt,
                                  e.target.value
                                )
                              )
                            }
                          }}
                          className={cn(
                            UNDERLINE_INPUT_CLASSES,
                            "form-theme-text flex-1"
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => removeOption(q.id, i)}
                          aria-label={`Remove option ${i + 1}`}
                          className="shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover/option:opacity-100 hover:text-destructive focus-visible:opacity-100"
                        >
                          <HugeiconsIcon icon={Cancel01Icon} size={14} />
                        </button>
                      </div>
                    ))}
                    {/*
                     * Answers, conditions and the answer key all name an
                     * option by its text, so two with the same text are one
                     * choice. The form shows them once; this says why.
                     */}
                    {hasDuplicateOptions(q.options) && (
                      <p className="text-xs text-destructive">
                        Two options have the same text, so respondents see
                        them as one choice. Give each option a different name.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        updateQuestion(q.id, {
                          options: [...(q.options ?? []), ""],
                        })
                      }
                      className="form-theme-accent-text mt-1 self-start text-sm transition-transform duration-150 ease-out active:scale-[0.97]"
                    >
                      + Add option
                    </button>
                    {/*
                     * Other is not an option in the list, it is a property of
                     * the question: it has no label to edit, cannot be
                     * reordered among the others, and a respondent's answer to
                     * it is their own text rather than this value. Dropdown is
                     * excluded because a native select has nowhere to type.
                     */}
                    {(q.type === "multiple_choice" ||
                      q.type === "checkboxes") && (
                      <label className="mt-2 flex items-center gap-2 self-start text-sm text-muted-foreground">
                        <Checkbox
                          checked={q.allowOther === true}
                          onCheckedChange={(checked) =>
                            updateQuestion(q.id, {
                              allowOther: checked === true ? true : undefined,
                            })
                          }
                        />
                        Add an &ldquo;Other&rdquo; choice with a text box
                      </label>
                    )}
                  </div>
                )}

                {(() => {
                  const sources = conditionSources(questions, i)
                  const condition = q.condition
                  // "Usable source" is the renderer's test too: present, earlier,
                  // choice-like and option-bearing. A source that still exists but
                  // had its type changed is dangling just as much as a deleted one.
                  const dangling =
                    condition !== undefined &&
                    sources.every((s) => s.id !== condition.questionId)
                  const source =
                    condition !== undefined && !dangling
                      ? sources.find((s) => s.id === condition.questionId)
                      : undefined
                  // Fail open, exactly as the renderer does: a dangling reference shows the
                  // question rather than hiding it forever. Warn, never auto-delete: the
                  // author may be mid-edit. The warning has to survive the source's
                  // deletion, so it renders whenever a condition exists; only the
                  // editor selects need an eligible source to point at.
                  const staleValue =
                    condition !== undefined &&
                    source !== undefined &&
                    !(source.options ?? []).includes(condition.value)

                  if (condition === undefined && sources.length === 0)
                    return null

                  return (
                    <div className="mt-3 pt-3">
                      {condition === undefined ? (
                        <button
                          type="button"
                          onClick={() =>
                            updateQuestion(q.id, {
                              condition: {
                                questionId: sources[0].id,
                                operator: "is",
                                value: sources[0].options?.[0] ?? "",
                              },
                            })
                          }
                          className="form-theme-accent-text text-sm transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100"
                        >
                          + Only show this if…
                        </button>
                      ) : sources.length === 0 ? null : (
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="text-muted-foreground">Show if</span>
                          <select
                            aria-label="Condition question"
                            value={condition.questionId}
                            onChange={(event) => {
                              const next = questions.find(
                                (o) => o.id === event.target.value
                              )
                              updateQuestion(q.id, {
                                condition: {
                                  questionId: event.target.value,
                                  operator: condition.operator,
                                  value: next?.options?.[0] ?? "",
                                },
                              })
                            }}
                            className="rounded-md border border-border bg-background px-2 py-1"
                          >
                            {dangling && (
                              <option value={condition.questionId}>
                                (unavailable question)
                              </option>
                            )}
                            {sources.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label || "Untitled question"}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="Condition operator"
                            value={condition.operator}
                            onChange={(event) =>
                              updateQuestion(q.id, {
                                condition: {
                                  ...condition,
                                  operator: event.target.value as
                                    "is" | "is_not",
                                },
                              })
                            }
                            className="rounded-md border border-border bg-background px-2 py-1"
                          >
                            <option value="is">is</option>
                            <option value="is_not">is not</option>
                          </select>
                          <select
                            aria-label="Condition value"
                            value={condition.value}
                            onChange={(event) =>
                              updateQuestion(q.id, {
                                condition: {
                                  ...condition,
                                  value: event.target.value,
                                },
                              })
                            }
                            className="rounded-md border border-border bg-background px-2 py-1"
                          >
                            {staleValue && (
                              <option value={condition.value}>
                                {condition.value} (removed)
                              </option>
                            )}
                            {distinctOptions(source?.options).map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              updateQuestion(q.id, { condition: undefined })
                            }
                            aria-label="Remove condition"
                            className="text-muted-foreground transition-all duration-150 ease-out hover:text-destructive active:scale-[0.97] motion-reduce:active:scale-100"
                          >
                            <HugeiconsIcon icon={Cancel01Icon} size={14} />
                          </button>
                        </div>
                      )}
                      {(dangling || staleValue) && (
                        <Alert variant="destructive" className="mt-2">
                          <HugeiconsIcon icon={AlertCircleIcon} />
                          <AlertTitle>
                            {dangling
                              ? "This condition is ignored"
                              : "This condition never matches"}
                          </AlertTitle>
                          {/* The descriptions are asserted verbatim by
                              form-builder.test.tsx and full-flow.spec.ts.
                              Changing the wording means changing those too. */}
                          <AlertDescription>
                            {dangling
                              ? "This condition points at a question that is no longer a usable source, either because it was deleted or because it is no longer a choice question, so it is ignored and this question always shows."
                              : "This condition points at an option that no longer exists, so the question stays hidden."}
                            {dangling && sources.length === 0
                              ? " There is no earlier choice question to point it at instead."
                              : null}
                          </AlertDescription>
                          {/* With no source to point at, the editor row above
                              is not rendered, so the alert carries the only way
                              to clear the condition. sources.length === 0
                              implies dangling, so this alert is always the one
                              on screen in that case. */}
                          {sources.length === 0 && (
                            <AlertAction>
                              <button
                                type="button"
                                onClick={() =>
                                  updateQuestion(q.id, { condition: undefined })
                                }
                                aria-label="Remove condition"
                                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-destructive/70 transition-all duration-150 ease-out hover:bg-destructive/10 hover:text-destructive active:scale-[0.97] motion-reduce:active:scale-100"
                              >
                                <HugeiconsIcon icon={Cancel01Icon} size={13} />
                                Remove
                              </button>
                            </AlertAction>
                          )}
                        </Alert>
                      )}
                    </div>
                  )
                })()}

                {quizOn && answerKey && openKeyIds.has(q.id) && (
                  <AnswerKeyEditor
                    question={q}
                    entry={entryFor(answerKey, q.id)}
                    onChange={(entry) =>
                      onAnswerKeyChange?.({
                        ...answerKey,
                        questions: { ...answerKey.questions, [q.id]: entry },
                      })
                    }
                  />
                )}

                <div className="mt-10 flex items-center justify-end gap-3 border-t border-border/70 pt-3">
                  {quizOn && answerKey && (
                    <button
                      type="button"
                      aria-label={`Answer key for question ${i + 1} (${
                        entryFor(answerKey, q.id)?.points ?? 0
                      } ${
                        (entryFor(answerKey, q.id)?.points ?? 0) === 1
                          ? "pt"
                          : "pts"
                      })`}
                      aria-expanded={openKeyIds.has(q.id)}
                      onClick={() => toggleKeyEditor(q.id)}
                      className="form-theme-accent-text mr-auto text-sm transition-transform duration-150 ease-out active:scale-[0.97]"
                    >
                      Answer key ({entryFor(answerKey, q.id)?.points ?? 0}{" "}
                      {(entryFor(answerKey, q.id)?.points ?? 0) === 1
                        ? "pt"
                        : "pts"}
                      )
                    </button>
                  )}
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    Required
                    <Switch
                      checked={q.required ?? false}
                      onCheckedChange={(checked) =>
                        updateQuestion(q.id, { required: checked })
                      }
                    />
                  </label>
                  <div className="h-4 w-px bg-border" />
                  <button
                    type="button"
                    onClick={() => duplicateQuestionById(q.id)}
                    aria-label="Duplicate question"
                    className="text-muted-foreground transition-all duration-150 ease-out hover:text-foreground active:scale-[0.97] motion-reduce:active:scale-100"
                  >
                    <HugeiconsIcon icon={Copy01Icon} size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQuestion(q.id)}
                    aria-label="Delete question"
                    className="text-muted-foreground transition-all duration-150 ease-out hover:text-destructive active:scale-[0.97] motion-reduce:active:scale-100"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={16} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={addQuestion}
          className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-card/70 py-2.5 text-sm text-muted-foreground transition-colors duration-150 ease-out hover:bg-card hover:text-foreground active:scale-[0.99]"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={16} />
          Add question
        </button>
      </div>
    </>
  )

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {reorderMessage}
      </p>
      <FormThemeSurface
        theme={theme}
        mode={editorRenderMode}
        className="flex-1"
      >
        <main
          data-testid="form-builder-workspace"
          className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_18rem]"
        >
          <section className="min-w-0">{formEditor}</section>
          <aside className="order-first lg:order-none">
            <div className="rounded-xl border border-border bg-card p-4 lg:sticky lg:top-4 lg:max-h-[calc(100svh-11rem)] lg:overflow-y-auto lg:overscroll-contain">
              <div className="lg:hidden">
                <Collapsible
                  open={appearanceOpen}
                  onOpenChange={setAppearanceOpen}
                >
                  <CollapsibleTrigger
                    aria-expanded={appearanceOpen}
                    className="flex w-full items-center justify-between text-sm font-medium"
                  >
                    Appearance
                    <HugeiconsIcon
                      icon={appearanceOpen ? ArrowUp01Icon : ArrowDown01Icon}
                      size={16}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-4">
                    <AppearancePanel
                      value={theme}
                      onChange={onThemeChange}
                      headerImage={headerImage}
                    />
                  </CollapsibleContent>
                </Collapsible>
              </div>
              <div className="hidden lg:block">
                <AppearancePanel
                  value={theme}
                  onChange={onThemeChange}
                  idPrefix="desktop-"
                  headerImage={headerImage}
                />
              </div>
            </div>
          </aside>
        </main>
      </FormThemeSurface>

      <FormPreview
        open={previewOpen}
        onOpenChange={onPreviewOpenChange}
        title={title}
        questions={questions}
        theme={theme}
        headerImageUrl={headerImage?.previewUrl ?? null}
      />
    </>
  )
}
