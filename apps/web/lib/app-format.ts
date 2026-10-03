import type { AppLanguage } from "./app-locale"

/*
 * Every number, date and size the workspace prints goes through here, so the
 * two languages agree on one rule: Western digits (0-9) and the Gregorian
 * calendar, with Arabic month names and units. Arabic-Indic digits would make
 * a count in the app differ from the same count in a CSV or a form.
 */
export type AppFormatters = {
  number: (value: number) => string
  decimal: (value: number, places: number) => string
  date: (value: string | Date, withTime?: boolean) => string
  megabytes: (bytes: number) => string
  /** A size in the largest unit that keeps it under 1024: B, KB, MB, GB, TB. */
  bytes: (bytes: number) => string
}

const UNITS: Record<AppLanguage, string[]> = {
  en: ["B", "KB", "MB", "GB", "TB"],
  ar: ["بايت", "كيلوبايت", "ميغابايت", "غيغابايت", "تيرابايت"],
}
const CACHE = new Map<AppLanguage, AppFormatters>()

function build(language: AppLanguage): AppFormatters {
  const locale = `${language}-u-nu-latn-ca-gregory`
  const decimalFormats = new Map<number, Intl.NumberFormat>()
  const integers = new Intl.NumberFormat(locale)
  const dates = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
  const dateTimes = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

  const decimal = (value: number, places: number) => {
    let format = decimalFormats.get(places)
    if (format === undefined) {
      format = new Intl.NumberFormat(locale, {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
        useGrouping: false,
      })
      decimalFormats.set(places, format)
    }
    return format.format(value)
  }

  return {
    number: (value) => integers.format(value),
    decimal,
    date: (value, withTime = false) => {
      const parsed = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(parsed.getTime())) return ""
      return (withTime ? dateTimes : dates).format(parsed)
    },
    megabytes: (bytes) =>
      `${decimal(bytes / (1024 * 1024), 1)} ${UNITS[language][2]}`,
    bytes: (bytes) => {
      const units = UNITS[language]
      if (bytes < 1024) return `${integers.format(bytes)} ${units[0]}`
      let value = bytes / 1024
      let index = 1
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${decimal(value, value >= 10 ? 0 : 1)} ${units[index]}`
    },
  }
}

export function appFormatters(language: AppLanguage): AppFormatters {
  let formatters = CACHE.get(language)
  if (formatters === undefined) {
    formatters = build(language)
    CACHE.set(language, formatters)
  }
  return formatters
}
