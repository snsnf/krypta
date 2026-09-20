/**
 * Encoding for a respondent's own answer to a choice question.
 *
 * The marker has to survive being stored as an ordinary option value, because
 * a response is `string | string[]` and encrypted: changing that shape later
 * would mean migrating ciphertext the server cannot read. So an "Other" answer
 * is still a string, distinguished by a prefix.
 *
 * U+0000 is the separator because a respondent cannot type it and no creator
 * can paste it into an option label through the builder's inputs. This repo
 * already uses it the same way, joining font families into a cache key in
 * `form-theme-surface.tsx`.
 */
const OTHER_PREFIX = "\u0000other:"

/** The value stored when someone picks Other and writes `text`. */
export function encodeOtherAnswer(text: string): string {
  return `${OTHER_PREFIX}${text}`
}

export function isOtherAnswer(value: string): boolean {
  return value.startsWith(OTHER_PREFIX)
}

/** The written text, or null when this is an ordinary option. */
export function decodeOtherAnswer(value: string): string | null {
  return isOtherAnswer(value) ? value.slice(OTHER_PREFIX.length) : null
}

/**
 * What to show a reader. An Other answer displays as what the person wrote,
 * never as the marker, and an empty one is named rather than shown blank.
 */
export function displayAnswer(value: string): string {
  const text = decodeOtherAnswer(value)
  if (text === null) return value
  return text.trim() === "" ? "Other" : text
}

/**
 * Selecting Other and writing nothing is not an answer. A required question
 * must reject it, or "required" is satisfiable by ticking a box and typing
 * nothing, which is exactly what the free-text box is there to prevent.
 */
export function isEmptyOtherAnswer(value: string): boolean {
  const text = decodeOtherAnswer(value)
  return text !== null && text.trim() === ""
}
