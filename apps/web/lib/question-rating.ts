import type { Question, RatingSettings } from "@krypta/crypto"

/**
 * The one reader of a rating question's settings.
 *
 * The settings arrive inside a decrypted schema, which is untrusted input: a
 * schema written by a newer build or by hand could ask for a thousand buttons
 * or a style this build cannot draw. Everything that needs the range (the
 * field, the builder, draft reconciling, the summary and the visibility
 * evaluator) asks here, so one clamp protects all of them and they cannot
 * disagree about which values exist.
 */

export const DEFAULT_RATING: RatingSettings = { style: "stars", min: 1, max: 5 }
export const DEFAULT_SCALE: RatingSettings = { style: "scale", min: 1, max: 5 }

export const STAR_COUNTS = [3, 4, 5, 6, 7, 8, 9, 10]
export const SCALE_ENDS = [2, 3, 4, 5, 6, 7, 8, 9, 10]

function clampedInteger(
  value: unknown,
  low: number,
  high: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback
  return Math.min(high, Math.max(low, value))
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

export function ratingRange(question: Pick<Question, "rating">): RatingSettings {
  const settings = question.rating
  if (settings?.style === "scale") {
    const range: RatingSettings = {
      style: "scale",
      min: settings.min === 0 ? 0 : 1,
      max: clampedInteger(settings.max, 2, 10, DEFAULT_SCALE.max),
    }
    const minLabel = label(settings.minLabel)
    const maxLabel = label(settings.maxLabel)
    if (minLabel !== undefined) range.minLabel = minLabel
    if (maxLabel !== undefined) range.maxLabel = maxLabel
    return range
  }
  return {
    style: "stars",
    min: 1,
    max: clampedInteger(settings?.max, 3, 10, DEFAULT_RATING.max),
  }
}

export function ratingValues(question: Pick<Question, "rating">): string[] {
  const { min, max } = ratingRange(question)
  return Array.from({ length: max - min + 1 }, (_, i) => String(min + i))
}

/**
 * The chosen value, or null for anything that is not an integer inside the
 * current range. Strict on purpose: " 3" and "3.0" were never produced by the
 * field, so they are leftovers rather than answers.
 */
export function parseRatingAnswer(
  question: Pick<Question, "rating">,
  value: unknown
): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  const picked = Number(value)
  const { min, max } = ratingRange(question)
  return picked >= min && picked <= max ? picked : null
}
