type HourlyFormatOptions = {
  timeZone?: string
  includeOffset?: boolean
}

type LocalHourParts = {
  year: string
  month: string
  day: string
  hour: string
}

function getResolvedTimeZone(timeZone?: string): string | undefined {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
}

function getLocalHourParts(
  utcIso: string,
  timeZone?: string,
): LocalHourParts | null {
  const date = new Date(utcIso)
  if (Number.isNaN(date.getTime())) return null

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: getResolvedTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  })

  const parts = formatter.formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value
  const hour = parts.find((part) => part.type === "hour")?.value

  if (!year || !month || !day || !hour) return null
  return { year, month, day, hour }
}

function getOffsetLabel(utcIso: string, timeZone?: string): string | null {
  const date = new Date(utcIso)
  if (Number.isNaN(date.getTime())) return null

  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: getResolvedTimeZone(timeZone),
    hour: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  })

  return (
    formatter
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")
      ?.value ?? null
  )
}

/** Format daily date label: "YYYY-MM-DD" -> "MM-DD" */
export function formatDailyLabel(dateStr: string): string {
  const match = /(\d{2})-(\d{2})$/.exec(dateStr)
  return match ? `${match[1]}-${match[2]}` : dateStr
}

/**
 * Format a UTC ISO hour bucket (e.g., "2026-04-15T14:00:00Z")
 * for display in browser local time.
 */
export function formatHourlyLabel(
  utcIso: string,
  showDate: boolean,
  options: HourlyFormatOptions = {},
): string {
  const parts = getLocalHourParts(utcIso, options.timeZone)
  if (!parts) return utcIso

  const prefix = showDate ? `${parts.month}-${parts.day} ` : ""
  const suffix = options.includeOffset ? ` ${getOffsetLabel(utcIso, options.timeZone) ?? ""}` : ""
  return `${prefix}${parts.hour}:00${suffix}`.trimEnd()
}

/** Check if UTC ISO hour buckets span multiple local calendar days. */
export function hourlyDataCrossesDays(
  dates: string[],
  timeZone?: string,
): boolean {
  const localDays = new Set<string>()
  for (const value of dates) {
    const parts = getLocalHourParts(value, timeZone)
    if (!parts) continue
    localDays.add(`${parts.year}-${parts.month}-${parts.day}`)
  }
  return localDays.size > 1
}

/** Format full local date+time for tooltip. */
export function formatHourlyTooltip(
  utcIso: string,
  options: HourlyFormatOptions = {},
): string {
  const parts = getLocalHourParts(utcIso, options.timeZone)
  if (!parts) return utcIso

  const suffix = options.includeOffset ? ` ${getOffsetLabel(utcIso, options.timeZone) ?? ""}` : ""
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:00${suffix}`.trimEnd()
}
