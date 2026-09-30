"use client"

import { useEffect, useRef, useState } from "react"
import type { Question } from "@krypta/crypto"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  CloudUploadIcon,
  File02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { RatingField } from "@/components/rating-field"
import type { AnswerValue, FileAnswer } from "@/hooks/use-public-form-answers"
import {
  decodeOtherAnswer,
  encodeOtherAnswer,
  isOtherAnswer,
} from "@/lib/form-other"
import { distinctOptions } from "@/lib/question-options"
import { useFormLanguage, useFormT } from "@/lib/form-i18n"
import { usesNumericShortcuts } from "@/lib/form-language"

const TEXTAREA_CLASSES =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

const SELECT_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

/* An empty bordered box gives a respondent nothing to act on, so text fields
   carry the `yourAnswer` placeholder. Date is the one exception: the browser
   already renders its own dd/mm/yyyy hint. */

/* A number question looked exactly like a text question. `type="number"` only
   shows its spinners on desktop, on hover, and never on a phone, so the field
   asked for a number while telling the respondent nothing. The placeholder is
   what actually says so; `inputMode` then gets the numeric keypad up on a
   phone, where the spinners were never going to help. "decimal" rather than
   "numeric" because the question type does not forbid a decimal point, and a
   keypad without one would make a valid answer untypable. The placeholder
   is the `enterNumber` message. */

/**
 * Classic puts every question on the page at once, so an option row has to
 * read as a control inside its card. Focus shows one question at a time, where
 * the options are the whole screen and can afford to be a card each. Both
 * layouts share this component, so that difference lives here rather than in
 * two copies of the markup.
 *
 * Compact drops the border rather than lightening it: a bordered row inside a
 * bordered card is two nested box languages, and the fill plus hover already
 * says "pressable".
 */
type FieldDensity = "compact" | "comfortable"

const OPTION_ROW_CLASSES: Record<FieldDensity, string> = {
  compact:
    "form-theme-text group/option flex cursor-pointer items-center gap-2.5 rounded-xl border border-transparent bg-foreground/[0.03] px-3 py-2 transition-colors duration-150 ease-out hover:bg-foreground/[0.06]",
  comfortable:
    "form-theme-option form-theme-text group/option flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-foreground/[0.02] px-4 py-3 transition-colors duration-150 ease-out hover:bg-foreground/[0.05]",
}

/**
 * Selection is where the two layouts diverge most. Focus shows one question,
 * so flooding the chosen row with the accent is the answer and reads as a
 * commitment. Classic shows every question at once, so the same fill turns a
 * scrolled page into stacked blocks of solid colour. Classic therefore colours
 * only the control, the way a paper form ticks a box, and leaves the row alone.
 *
 * `form-theme-option` rides on the filled row only, because the globals.css
 * rule behind it inverts the checkbox against an accent background. On an
 * unfilled Classic row the checkbox wants the ordinary themed treatment.
 */
const OPTION_ROW_SELECTED: Record<
  FieldDensity,
  Record<"radio" | "check", string>
> = {
  compact: { radio: "", check: "" },
  comfortable: {
    radio:
      "has-[:checked]:border-transparent has-[:checked]:bg-[var(--form-accent)] has-[:checked]:text-[var(--form-accent-foreground)]",
    check:
      "has-[[data-checked]]:border-transparent has-[[data-checked]]:bg-[var(--form-accent)] has-[[data-checked]]:text-[var(--form-accent-foreground)]",
  },
}

const CHECKBOX_CLASSES: Record<FieldDensity, string> = {
  compact: "form-theme-checkbox",
  /* Checked, the row fills with the accent and the checkbox's own
     data-checked:bg-primary sits at almost the same colour, so the box
     vanishes and leaves a bare tick. Invert it against the row instead. */
  comfortable:
    "form-theme-checkbox data-checked:border-transparent data-checked:bg-[var(--form-accent-foreground)] data-checked:text-[var(--form-accent)] dark:data-checked:bg-[var(--form-accent-foreground)]",
}

/**
 * Focus labels its options A, B, C, and those letters are pressable: see
 * `optionShortcutIndex` and the key handler in `focus-form-renderer.tsx`.
 * Classic gets a plain radio instead, because a letter that selects nothing is
 * decoration that has to be translated.
 *
 * Past 26 options the letters run out, so numbering takes over rather than
 * walking off the end of the alphabet into `[`, `\` and `]`.
 *
 * `numeric` is for forms in a language whose keyboard does not type Latin
 * letters (Arabic): the badges are 1 to 9 and so are the keys, and options
 * past nine have no shortcut.
 */
const OPTION_SHORTCUT_LIMIT = 26
const NUMERIC_SHORTCUT_LIMIT = 9

function optionMarker(index: number, numeric: boolean): string {
  // Past nine a number has no single key, so it would promise a shortcut
  // that does nothing; the badge stays empty instead.
  if (numeric) return index < NUMERIC_SHORTCUT_LIMIT ? String(index + 1) : ""
  return index < OPTION_SHORTCUT_LIMIT
    ? String.fromCharCode(65 + index)
    : String(index + 1)
}

/**
 * The value of a typed digit, or -1. Arabic and Persian keyboards type their
 * own digits on the number row (U+0660..0669, U+06F0..06F9), so a respondent
 * pressing the key under "1" must reach option 1 whichever they produce.
 */
function digitValue(key: string): number {
  const code = key.charCodeAt(0)
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x660 && code <= 0x669) return code - 0x660
  if (code >= 0x6f0 && code <= 0x6f9) return code - 0x6f0
  return -1
}

/**
 * Maps a pressed key back to an option index, or -1. Lives here so the badge
 * and the shortcut cannot disagree about which key means which option.
 */
export function optionShortcutIndex(
  key: string,
  optionCount: number,
  numeric = false
): number {
  if (key.length !== 1) return -1
  const index = numeric
    ? digitValue(key) - 1
    : key.toUpperCase().charCodeAt(0) - 65
  const usable = Math.min(
    optionCount,
    numeric ? NUMERIC_SHORTCUT_LIMIT : OPTION_SHORTCUT_LIMIT
  )
  return index >= 0 && index < usable ? index : -1
}

/**
 * Concentric corners: a rounded child sitting close to a rounded parent should
 * share its center of curvature, so `inner = outer - inset`. The badge is
 * inset by the row's vertical padding: 18px row - py-3 (12px) = 6px.
 */
const OPTION_BADGE_CLASSES =
  "flex size-6 shrink-0 items-center justify-center rounded-sm border border-border bg-background text-xs font-medium text-muted-foreground transition-colors duration-150 ease-out group-has-[:checked]/option:border-transparent group-has-[:checked]/option:bg-[var(--form-accent-foreground)] group-has-[:checked]/option:text-[var(--form-accent)]"

/* Classic only. The row behind it stays neutral, so the ring and the dot are
   the whole signal: accent on both, matching the checkbox opposite it. */
const RADIO_DOT_CLASSES =
  "flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-background transition-colors duration-150 ease-out group-has-[:checked]/option:border-[var(--form-accent)]"

interface FormQuestionFieldProps {
  question: Question
  density?: FieldDensity
  value: AnswerValue | undefined
  onChange: (value: AnswerValue) => void
  onToggleCheckbox: (option: string) => void
  onFileSelect: (file: File | undefined) => void
  uploading: boolean
  uploadError: string | undefined
}

export function FormQuestionField({
  question,
  density = "comfortable",
  value,
  onChange,
  onToggleCheckbox,
  onFileSelect,
  uploading,
  uploadError,
}: FormQuestionFieldProps) {
  const t = useFormT()
  const numericMarkers = usesNumericShortcuts(useFormLanguage())
  if (question.type === "short_text") {
    return (
      <Input
        dir="auto"
        id={question.id}
        required={question.required}
        placeholder={t("yourAnswer")}
        value={(value as string) ?? ""}
        className="form-theme-input form-theme-text"
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  if (question.type === "long_text") {
    return (
      <textarea
        dir="auto"
        id={question.id}
        required={question.required}
        placeholder={t("yourAnswer")}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className={`${TEXTAREA_CLASSES} form-theme-input form-theme-text`}
      />
    )
  }

  if (
    question.type === "number" ||
    question.type === "email" ||
    question.type === "date"
  ) {
    return (
      <Input
        dir="auto"
        id={question.id}
        type={question.type}
        inputMode={question.type === "number" ? "decimal" : undefined}
        required={question.required}
        placeholder={
          question.type === "date"
            ? undefined
            : question.type === "number"
              ? t("enterNumber")
              : t("yourAnswer")
        }
        value={(value as string) ?? ""}
        className="form-theme-input form-theme-text"
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  if (question.type === "rating") {
    return (
      <RatingField
        question={question}
        value={typeof value === "string" ? value : undefined}
        onChange={onChange}
      />
    )
  }

  if (question.type === "dropdown") {
    return (
      <select
        id={question.id}
        required={question.required}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={`${SELECT_CLASSES} form-theme-input form-theme-text`}
      >
        <option className="form-theme-text" value="" disabled>
          {t("selectOption")}
        </option>
        {distinctOptions(question.options).map((opt) => (
          <option className="form-theme-text" key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }

  if (question.type === "multiple_choice") {
    return (
      <div
        role="radiogroup"
        aria-label={question.label}
        className="flex flex-col gap-2"
      >
        {distinctOptions(question.options).map((opt, i) => (
          <label
            key={opt}
            /* The radio itself is sr-only, so it is clipped to 1x1 and its own
               focus ring is invisible. Without has-[:focus-visible] a keyboard
               user arrowing through the group sees nothing move: WCAG 2.4.7.
               Ring only, no border: has-[:checked] already sets the border and
               the two variants have equal specificity. */
            className={cn(
              OPTION_ROW_CLASSES[density],
              OPTION_ROW_SELECTED[density].radio,
              "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
            )}
          >
            {/* aria-hidden on both: the marker is a visual affordance, and
                without this the option's accessible name is "A Yes". */}
            {density === "compact" ? (
              <span aria-hidden="true" className={RADIO_DOT_CLASSES}>
                <span className="size-1.5 rounded-full bg-[var(--form-accent)] opacity-0 transition-opacity duration-150 ease-out group-has-[:checked]/option:opacity-100" />
              </span>
            ) : (
              <span aria-hidden="true" className={OPTION_BADGE_CLASSES}>
                {optionMarker(i, numericMarkers)}
              </span>
            )}
            <input
              type="radio"
              name={question.id}
              value={opt}
              required={question.required}
              checked={value === opt}
              onChange={() => onChange(opt)}
              className="sr-only"
            />
            {opt}
          </label>
        ))}
        {question.allowOther && (
          <OtherChoiceRow
            question={question}
            density={density}
            selected={typeof value === "string" && isOtherAnswer(value)}
            text={
              typeof value === "string" ? (decodeOtherAnswer(value) ?? "") : ""
            }
            control="radio"
            onSelect={() => onChange(encodeOtherAnswer(""))}
            onTextChange={(text) => onChange(encodeOtherAnswer(text))}
          />
        )}
      </div>
    )
  }

  if (question.type === "checkboxes") {
    return (
      <div className="flex flex-col gap-2">
        {distinctOptions(question.options).map((opt) => (
          <label
            key={opt}
            className={cn(
              OPTION_ROW_CLASSES[density],
              OPTION_ROW_SELECTED[density].check
            )}
          >
            <Checkbox
              className={CHECKBOX_CLASSES[density]}
              checked={((value as string[] | undefined) ?? []).includes(opt)}
              onCheckedChange={() => onToggleCheckbox(opt)}
            />
            {opt}
          </label>
        ))}
        {question.allowOther &&
          (() => {
            const selections = (value as string[] | undefined) ?? []
            const entry = selections.find(isOtherAnswer)
            const withoutOther = selections.filter(
              (selection) => !isOtherAnswer(selection)
            )
            return (
              <OtherChoiceRow
                question={question}
                density={density}
                selected={entry !== undefined}
                text={
                  entry === undefined ? "" : (decodeOtherAnswer(entry) ?? "")
                }
                control="check"
                onSelect={() =>
                  onChange(
                    entry === undefined
                      ? [...withoutOther, encodeOtherAnswer("")]
                      : withoutOther
                  )
                }
                onTextChange={(text) =>
                  onChange([...withoutOther, encodeOtherAnswer(text)])
                }
              />
            )
          })()}
      </div>
    )
  }

  // file_upload
  return (
    <FileUploadField
      question={question}
      density={density}
      value={value}
      onFileSelect={onFileSelect}
      uploading={uploading}
      uploadError={uploadError}
    />
  )
}

/*
 * The "Other" row. Its text lives in the answer rather than in local state, so
 * there is one source of truth and a revisited response repopulates the box
 * without any restore step.
 *
 * The control's accessible name is "Other" and the text box carries its own
 * label, rather than the box being the control's name: a respondent tabbing
 * through hears a choice, then a field, which is what they are.
 */
function OtherChoiceRow({
  question,
  density = "comfortable",
  selected,
  text,
  control,
  onSelect,
  onTextChange,
}: {
  question: Question
  density?: FieldDensity
  selected: boolean
  text: string
  control: "radio" | "check"
  onSelect: () => void
  onTextChange: (text: string) => void
}) {
  const t = useFormT()
  /*
   * A label wrapping the whole row, so tapping anywhere on it chooses Other.
   * It used to be a div with only the control and the word labelled, which
   * left most of the row dead: a respondent aiming at the row had to hit the
   * small circle or the word itself, and on a phone that is a miss more often
   * than a hit.
   *
   * This was originally a div on the reasoning that the text box sits inside
   * the row, so a wrapping label would toggle the control every time someone
   * clicked into the box, switching a checkbox back off on the way to typing.
   * That does not happen: a label's activation behaviour is defined to do
   * nothing for events targeted at its interactive descendants, and a text
   * input is interactive content. Clicking the box only focuses the box.
   */
  const inputRef = useRef<HTMLInputElement>(null)
  /*
   * Focused on the rising edge only. Focusing whenever `selected` is true would
   * also fire when a revisited response mounts with Other already chosen, which
   * would steal the caret and jump the page to this question on load.
   */
  const wasSelected = useRef(selected)
  useEffect(() => {
    if (selected && !wasSelected.current) inputRef.current?.focus()
    wasSelected.current = selected
  }, [selected])

  return (
    <label
      className={cn(
        OPTION_ROW_CLASSES[density],
        OPTION_ROW_SELECTED[density][control],
        control === "radio" &&
          "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
      )}
    >
      <span className="flex shrink-0 items-center gap-3">
        {control === "radio" ? (
          <>
            {/*
             * A dot rather than a letter badge, at every density. The badges
             * promise a keyboard shortcut that Focus wires up from the
             * options array, and Other is not in it: lettering this row would
             * offer a key that does nothing.
             */}
            <span aria-hidden="true" className={RADIO_DOT_CLASSES}>
              <span className="size-1.5 rounded-full bg-[var(--form-accent)] opacity-0 transition-opacity duration-150 ease-out group-has-[:checked]/option:opacity-100" />
            </span>
            <input
              type="radio"
              name={question.id}
              value="other"
              required={question.required}
              checked={selected}
              onChange={onSelect}
              className="sr-only"
            />
          </>
        ) : (
          <Checkbox
            className={CHECKBOX_CLASSES[density]}
            checked={selected}
            onCheckedChange={onSelect}
          />
        )}
        {t("other")}:
      </span>
      {/*
       * Only once Other is chosen. A line sitting beside an unselected control
       * invites typing into something that is not the answer yet, and for a
       * checkbox it would have to toggle the box on the way in, which reads as
       * the click doing two things.
       *
       * Colours come from currentColor so the field reads on both states of
       * the row: comfortable density floods a selected row with the accent,
       * and a fixed foreground would leave dark text on a dark fill.
       */}
      {selected && (
        <input
          dir="auto"
          ref={inputRef}
          type="text"
          aria-label={t("otherAnswerFor", { question: question.label })}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          className="form-theme-text min-w-0 flex-1 cursor-text border-0 border-b border-current/40 bg-transparent px-0 py-0.5 text-inherit transition-colors duration-150 ease-out outline-none focus:border-current"
        />
      )}
    </label>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileUploadField({
  question,
  density = "comfortable",
  value,
  onFileSelect,
  uploading,
  uploadError,
}: Pick<
  FormQuestionFieldProps,
  | "question"
  | "density"
  | "value"
  | "onFileSelect"
  | "uploading"
  | "uploadError"
>) {
  const [dragging, setDragging] = useState(false)
  const t = useFormT()
  const uploaded =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as FileAnswer)
      : undefined

  return (
    <div>
      {/*
       * The zone is a <label> for the input above rather than a click-handling
       * div, so the picker opens on click and on keyboard activation for free.
       * The input keeps `id={question.id}` because the question's own label
       * (in FormQuestionCard / FocusFormRenderer) points at it.
       *
       * The input is sr-only, so it is clipped to 1x1 and its own focus ring is
       * invisible: a keyboard user tabbing to it would see nothing (WCAG
       * 2.4.7). It sits *before* the label purely so `peer-focus-visible` can
       * put the ring on the zone: Tailwind's peer-* compiles to the general
       * sibling combinator, which only looks forwards.
       */}
      <input
        id={question.id}
        type="file"
        onChange={(e) => onFileSelect(e.target.files?.[0])}
        disabled={uploading}
        className="peer sr-only"
      />
      <label
        htmlFor={question.id}
        onDragOver={(event) => {
          event.preventDefault()
          if (!uploading) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (uploading) return
          onFileSelect(event.dataTransfer.files?.[0])
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-1.5 border border-dashed border-border px-4 text-center transition-[background-color,border-color,transform] duration-150 ease-out peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
          density === "compact" ? "rounded-lg py-5" : "rounded-xl py-7",
          uploading
            ? "cursor-wait"
            : "cursor-pointer hover:bg-foreground/[0.04] active:scale-[0.99] motion-reduce:active:scale-100",
          dragging &&
            "border-[var(--form-accent)] bg-[var(--form-accent)]/[0.07]"
        )}
      >
        {uploading ? (
          <>
            <HugeiconsIcon
              icon={Loading03Icon}
              size={22}
              className="animate-spin text-muted-foreground"
            />
            <p className="form-theme-text text-muted-foreground">
              {t("encryptingUpload")}
            </p>
          </>
        ) : uploaded ? (
          <div className="animate-list-item-in flex flex-col items-center gap-1.5">
            <span className="form-theme-accent-text flex size-9 items-center justify-center rounded-full bg-[var(--form-accent)]/[0.12]">
              <HugeiconsIcon icon={File02Icon} size={18} />
            </span>
            <p className="form-theme-text font-medium break-all">
              {/* Keeps the state legible to a screen reader, which otherwise
                  hears only a bare filename. */}
              <span className="sr-only">{t("uploadedPrefix")} </span>
              {uploaded.filename}
            </p>
            <p className="form-theme-text text-xs text-muted-foreground">
              {formatBytes(uploaded.size)} · {t("chooseDifferentFile")}
            </p>
          </div>
        ) : (
          <>
            <HugeiconsIcon
              icon={CloudUploadIcon}
              size={22}
              className="text-muted-foreground"
            />
            <p className="form-theme-text">
              <span className="form-theme-accent-text font-medium">
                {t("clickToUpload")}
              </span>{" "}
              {t("orDragDrop")}
            </p>
            {/* Mirrors MAX_FILE_BYTES in use-public-form-answers.ts, which
                owns the actual limit and rejects anything over it. */}
            <p className="form-theme-text text-xs text-muted-foreground">
              {t("uploadHint")}
            </p>
          </>
        )}
      </label>
      {uploadError && (
        <p className="form-theme-text mt-2 text-destructive">
          {uploadError === "fileTooLarge" || uploadError === "uploadFailed"
            ? t(uploadError)
            : uploadError}
        </p>
      )}
    </div>
  )
}
