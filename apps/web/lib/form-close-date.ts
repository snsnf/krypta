// `<input type="datetime-local">` reads and writes a local wall-clock string
// with no timezone (e.g. "2026-09-05T17:00"). The API stores and returns an
// RFC3339 UTC instant. These two pure helpers are the only place that
// conversion happens, so it can't be silently reintroduced inline and get the
// offset direction wrong.

/** Local `datetime-local` input value -> RFC3339 UTC string for the API. */
export function localDateTimeToUtcIso(local: string): string | null {
  if (local.trim() === "") return null
  const date = new Date(local)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/** RFC3339 UTC string from the API -> local `datetime-local` input value. */
export function utcIsoToLocalDateTime(utcIso: string | null): string {
  if (utcIso === null) return ""
  const date = new Date(utcIso)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}
