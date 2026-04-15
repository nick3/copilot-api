export type StatisticsTimePreset = "today" | "7d" | "month" | "custom"

export type StatisticsRange = {
  from: string
  to: string
  granularity: "day" | "hour"
  /** Browser-local start-of-day ms (only set for hourly granularity). */
  fromMs?: number
  /** Browser-local end-of-day ms (only set for hourly granularity). */
  toMs?: number
}

function toDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** End-of-day ms for a YYYY-MM-DD string. DST-safe (uses next-midnight − 1). */
export function localDateEndMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number)
  return new Date(y, m - 1, d + 1).getTime() - 1
}

/** Start-of-day ms for a YYYY-MM-DD string. */
export function localDateToMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number)
  return new Date(y, m - 1, d).getTime()
}

/**
 * Validate a custom date range.
 * Partial input is allowed so callers can still fall back to today.
 */
export function validateCustomRange(
  from: string,
  to: string,
): string | null {
  if (!from || !to) return null
  if (from > to) return "From date must not be after to date"
  return null
}

export function resolveStatisticsRange(params: {
  preset: StatisticsTimePreset
  customFrom: string
  customTo: string
  now?: Date
}): StatisticsRange {
  const { preset, customFrom, customTo, now = new Date() } = params
  const today = toDateString(now)

  if (preset === "today") {
    const startMs = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime()
    const endMs =
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      ).getTime() - 1
    return {
      from: today,
      to: today,
      granularity: "hour",
      fromMs: startMs,
      toMs: endMs,
    }
  }

  if (preset === "7d") {
    // 7 natural days including today: use calendar-day arithmetic to stay DST-safe.
    const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
    const from = toDateString(weekAgo)
    return {
      from,
      to: today,
      granularity: "day",
      fromMs: localDateToMs(from),
      toMs: localDateEndMs(today),
    }
  }

  if (preset === "month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const from = toDateString(startOfMonth)
    return {
      from,
      to: today,
      granularity: "day",
      fromMs: localDateToMs(from),
      toMs: localDateEndMs(today),
    }
  }

  const from = customFrom || today
  const to = customTo || today
  return {
    from,
    to,
    granularity: "day",
    fromMs: localDateToMs(from),
    toMs: localDateEndMs(to),
  }
}
