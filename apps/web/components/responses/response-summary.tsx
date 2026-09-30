"use client"

import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts"
import { HugeiconsIcon } from "@hugeicons/react"
import { File01Icon } from "@hugeicons/core-free-icons"
import type { Question } from "@krypta/crypto"

import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import type { AnswerValue } from "@/lib/form-answers"
import { summarizeResponses, type QuestionSummary } from "@/lib/response-summary"

const CARD_CLASSNAME = "rounded-lg border border-border bg-card p-4"

const CHOICE_CHART_CONFIG = {
  count: { label: "Responses", color: "var(--chart-1)" },
} satisfies ChartConfig

const RATING_CHART_CONFIG = {
  count: { label: "Responses", color: "var(--chart-1)" },
} satisfies ChartConfig

// Eight categorical hues in a fixed order (see globals.css). A bar's colour is
// keyed to its option's position in the QUESTION'S SCHEMA, never to its
// position in this chart: the bars are sorted by count, so rank-keyed colour
// would repaint every bar the moment a new response changed the order. Colour
// follows the entity.
const CHOICE_BAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
]

// Anything outside the categorical encoding (an option past the eighth, an
// answer no longer in the schema, or the aggregated "other" row) is
// achromatic, so colour never implies an identity the data does not have.
const CHOICE_BAR_NEUTRAL = "var(--chart-neutral)"

function choiceBarColor(value: string, schemaOptions: string[]): string {
  const index = schemaOptions.indexOf(value)
  if (index < 0 || index >= CHOICE_BAR_COLORS.length) return CHOICE_BAR_NEUTRAL
  return CHOICE_BAR_COLORS[index]
}

const TEXT_ANSWERS_PREVIEW_LIMIT = 50

// An edited question can turn every distinct free-text answer into its own
// bar (e.g. a short_text -> multiple_choice edit), and the aggregation in
// lib/response-summary.ts deliberately keeps every one of them: capping
// belongs to rendering, not to the data. Sorting and capping happen here in
// the render body rather than behind useMemo: manual memoisation the React
// Compiler cannot preserve is a lint error in this project, and sorting a
// handful of options is cheap.
const CHOICE_OPTIONS_LIMIT = 12

function AnsweredSkippedLine({
  answered,
  skipped,
}: {
  answered: number
  skipped: number
}) {
  return (
    <p className="text-sm text-muted-foreground">
      {answered} answered · {skipped} skipped
    </p>
  )
}

function ChoiceSummaryBody({
  summary,
  question,
}: {
  summary: Extract<QuestionSummary, { kind: "choice" }>
  question: Question
}) {
  const schemaOptions = new Set(question.options ?? [])
  const sorted = [...summary.options].sort((a, b) => b.count - a.count)

  let visible = sorted
  let otherLabel: string | null = null
  let otherCount = 0

  if (sorted.length > CHOICE_OPTIONS_LIMIT) {
    // The cap can force a choice between an owner's defined options and
    // unknown values left behind by response data (a removed option, or an
    // answer recorded under a type the question no longer is); prefer the
    // options the owner actually defined.
    const known = sorted.filter((o) => schemaOptions.has(o.value))
    const unknown = sorted.filter((o) => !schemaOptions.has(o.value))
    visible = [...known, ...unknown].slice(0, CHOICE_OPTIONS_LIMIT)

    const shown = new Set(visible.map((o) => o.value))
    const rest = sorted.filter((o) => !shown.has(o.value))
    otherCount = rest.reduce((sum, o) => sum + o.count, 0)
    otherLabel = `${rest.length} other answers`
  }

  const percentageOf = (count: number) =>
    summary.answered === 0 ? 0 : Math.round((count / summary.answered) * 100)

  const data = visible.map((option) => ({
    option: option.value,
    fill: choiceBarColor(option.value, question.options ?? []),
    count: option.count,
    percentage: percentageOf(option.count),
  }))
  if (otherLabel) {
    data.push({
      option: otherLabel,
      fill: CHOICE_BAR_NEUTRAL,
      count: otherCount,
      percentage: percentageOf(otherCount),
    })
  }

  const chartHeight = Math.max(data.length * 40 + 24, 80)

  return (
    <>
      <ChartContainer
        config={CHOICE_CHART_CONFIG}
        className="aspect-auto w-full"
        style={{ height: chartHeight }}
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 64, bottom: 4, left: 4 }}
        >
          <XAxis type="number" hide />
          <YAxis
            dataKey="option"
            type="category"
            tickLine={false}
            axisLine={false}
            width={120}
            tick={{ fontSize: 12 }}
          />
          <Bar dataKey="count" radius={4}>
            <LabelList
              dataKey="count"
              position="right"
              content={(props) => {
                const { x, y, width, height, index } = props as {
                  x?: number
                  y?: number
                  width?: number
                  height?: number
                  index?: number
                }
                const item = data[index ?? -1]
                if (!item || x === undefined || y === undefined) return null
                return (
                  <text
                    x={x + (width ?? 0) + 8}
                    y={y + (height ?? 0) / 2}
                    dy={4}
                    className="fill-foreground text-xs"
                  >
                    {`${item.count} (${item.percentage}%)`}
                  </text>
                )
              }}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
      {question.type === "checkboxes" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Respondents could choose more than one option, so percentages can
          add up to more than 100%.
        </p>
      )}
    </>
  )
}

function NumberSummaryBody({
  summary,
}: {
  summary: Extract<QuestionSummary, { kind: "number" }>
}) {
  if (summary.answered === 0) {
    return <p className="text-sm text-muted-foreground">No numeric answers yet.</p>
  }

  const stats = [
    { label: "Count", value: summary.answered },
    { label: "Min", value: summary.min },
    { label: "Max", value: summary.max },
    { label: "Mean", value: summary.mean.toFixed(2) },
    { label: "Median", value: summary.median },
  ]

  return (
    <div className="flex flex-wrap gap-4">
      {stats.map((stat) => (
        <div key={stat.label} className="flex flex-col">
          <span className="text-xs text-muted-foreground uppercase">
            {stat.label}
          </span>
          <span className="text-sm font-medium">{stat.value}</span>
        </div>
      ))}
    </div>
  )
}

/*
 * One colour for every bar: the values are an ordered scale, not categories,
 * so distinct hues would imply identities the data does not have. Bars run in
 * value order, never sorted by count, because the shape of the distribution
 * is the information.
 */
function RatingSummaryBody({
  summary,
}: {
  summary: Extract<QuestionSummary, { kind: "rating" }>
}) {
  if (summary.answered === 0) {
    return <p className="text-sm text-muted-foreground">No ratings yet.</p>
  }

  const data = summary.counts.map((entry) => ({
    value: String(entry.value),
    count: entry.count,
  }))

  return (
    <div data-testid="rating-summary">
      <p className="mb-2 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums">
          {summary.mean.toFixed(1)}
        </span>
        <span className="text-sm text-muted-foreground">
          out of {summary.max}
        </span>
      </p>
      <ChartContainer
        config={RATING_CHART_CONFIG}
        className="aspect-auto h-40 w-full"
      >
        <BarChart data={data} margin={{ top: 20, right: 4, bottom: 0, left: 4 }}>
          <XAxis
            dataKey="value"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 12 }}
          />
          <YAxis hide allowDecimals={false} />
          <Bar dataKey="count" fill="var(--chart-1)" radius={4}>
            <LabelList
              dataKey="count"
              position="top"
              className="fill-foreground text-xs"
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}

function DateSummaryBody({
  summary,
}: {
  summary: Extract<QuestionSummary, { kind: "date" }>
}) {
  if (summary.answered === 0) {
    return <p className="text-sm text-muted-foreground">No dated answers yet.</p>
  }

  return (
    <div className="flex flex-wrap gap-4">
      <div className="flex flex-col">
        <span className="text-xs text-muted-foreground uppercase">
          Earliest
        </span>
        <span className="text-sm font-medium">{summary.earliest}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-xs text-muted-foreground uppercase">
          Latest
        </span>
        <span className="text-sm font-medium">{summary.latest}</span>
      </div>
    </div>
  )
}

function TextSummaryBody({
  summary,
}: {
  summary: Extract<QuestionSummary, { kind: "text" }>
}) {
  if (summary.answered === 0) {
    return <p className="text-sm text-muted-foreground">No answers yet.</p>
  }

  const preview = summary.answers.slice(0, TEXT_ANSWERS_PREVIEW_LIMIT)
  const remaining = summary.answers.length - preview.length

  return (
    <div>
      <ul className="max-h-64 space-y-1 overflow-auto text-sm">
        {preview.map((answer, index) => (
          <li
            key={index}
            dir="auto"
            className="rounded border border-border/60 px-2 py-1"
          >
            {answer}
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {remaining} more: see the Individual view for the rest.
        </p>
      )}
    </div>
  )
}

function FileSummaryBody({
  summary,
}: {
  summary: Extract<QuestionSummary, { kind: "file" }>
}) {
  const total = summary.answered + summary.skipped
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <HugeiconsIcon icon={File01Icon} size={16} aria-hidden="true" />
      {summary.attached} of {total} responses attached a file
    </p>
  )
}

function QuestionSummaryCard({
  summary,
  question,
}: {
  summary: QuestionSummary
  question: Question
}) {
  return (
    <div className={CARD_CLASSNAME}>
      <h3 dir="auto" className="font-medium">
        {summary.label}
      </h3>
      <AnsweredSkippedLine answered={summary.answered} skipped={summary.skipped} />
      <div className="mt-3">
        {summary.kind === "choice" && (
          <ChoiceSummaryBody summary={summary} question={question} />
        )}
        {summary.kind === "number" && <NumberSummaryBody summary={summary} />}
        {summary.kind === "rating" && <RatingSummaryBody summary={summary} />}
        {summary.kind === "date" && <DateSummaryBody summary={summary} />}
        {summary.kind === "text" && <TextSummaryBody summary={summary} />}
        {summary.kind === "file" && <FileSummaryBody summary={summary} />}
      </div>
    </div>
  )
}

export function ResponseSummary({
  questions,
  responses,
}: {
  questions: Question[]
  responses: Record<string, AnswerValue>[]
}) {
  const summaries = summarizeResponses(questions, responses)
  const questionById = new Map(questions.map((q) => [q.id, q]))

  return (
    <div className="space-y-4">
      {summaries.map((summary) => {
        const question = questionById.get(summary.questionId)
        if (!question) return null
        return (
          <QuestionSummaryCard
            key={summary.questionId}
            summary={summary}
            question={question}
          />
        )
      })}
    </div>
  )
}
