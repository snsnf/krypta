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
}

const UNIT: Record<AppLanguage, string> = { en: "MB", ar: "ميغابايت" }
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
      `${decimal(bytes / (1024 * 1024), 1)} ${UNIT[language]}`,
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
