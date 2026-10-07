/**
 * The `dir` for a field holding user-written text.
 *
 * Typed text sets its own direction, but only once there is text: HTML
 * resolves `dir="auto"` on an empty field to left to right rather than to the
 * page's direction, which would push an Arabic placeholder and caret to the
 * left edge. Empty, the field inherits the page's direction instead.
 */
export function autoDir(value: string | undefined | null): "auto" | undefined {
  return value ? "auto" : undefined
}
