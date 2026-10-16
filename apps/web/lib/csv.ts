/**
 * One CSV cell. Every value is quoted, quotes are doubled, and a value that a
 * spreadsheet would run as a formula is prefixed with a quote so opening an
 * export cannot execute a respondent's text. The leading characters are
 * OWASP's list: = + - @, and the tab and carriage return a spreadsheet may
 * strip on import before reading what follows as a formula.
 */
export function csvCell(value: string): string {
  let v = value
  if (/^[=+\-@\t\r]/.test(v)) {
    v = `'${v}`
  }
  return `"${v.replace(/"/g, '""')}"`
}

/**
 * The whole file from an already-joined header line and row lines.
 *
 * Starts with a byte-order mark: without it Excel reads UTF-8 as the system's
 * legacy code page, and Arabic (or any non-Latin) answers open as gibberish.
 * Every other spreadsheet and text tool ignores the mark.
 */
export function csvDocument(headers: string[], rows: string[]): string {
  return "\uFEFF" + [headers.join(","), ...rows].join("\n")
}
