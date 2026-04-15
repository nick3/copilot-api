import type {
  DailyAccountStatsItem,
  DailyStatsItem,
} from "@/lib/admin-api"

function getResolvedTimeZone(timeZone?: string): string | undefined {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
}

function getLocalDayKey(utcIso: string, timeZone?: string): string {
  const date = new Date(utcIso)
  if (Number.isNaN(date.getTime())) return utcIso

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: getResolvedTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })

  const parts = formatter.formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value

  if (!year || !month || !day) return utcIso
  return `${year}-${month}-${day}`
}

export function aggregateHourlyStatsToLocalDays(
  items: readonly DailyStatsItem[],
  timeZone?: string,
): Array<DailyStatsItem> {
  const byDate = new Map<string, DailyStatsItem>()

  for (const item of items) {
    const date = getLocalDayKey(item.date, timeZone)
    const existing = byDate.get(date)
    if (existing) {
      existing.request_count += item.request_count
      existing.premium_consumed += item.premium_consumed
      existing.tokens_total += item.tokens_total
      existing.error_count += item.error_count
      continue
    }

    byDate.set(date, {
      date,
      request_count: item.request_count,
      premium_consumed: item.premium_consumed,
      tokens_total: item.tokens_total,
      error_count: item.error_count,
    })
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function aggregateHourlyAccountStatsToLocalDays(
  items: readonly DailyAccountStatsItem[],
  timeZone?: string,
): Array<DailyAccountStatsItem> {
  const byDateAccount = new Map<string, DailyAccountStatsItem>()

  for (const item of items) {
    const date = getLocalDayKey(item.date, timeZone)
    const key = `${date}|${item.account_id}`
    const existing = byDateAccount.get(key)
    if (existing) {
      existing.request_count += item.request_count
      existing.premium_consumed += item.premium_consumed
      existing.tokens_total += item.tokens_total
      existing.error_count += item.error_count
      continue
    }

    byDateAccount.set(key, {
      date,
      account_id: item.account_id,
      request_count: item.request_count,
      premium_consumed: item.premium_consumed,
      tokens_total: item.tokens_total,
      error_count: item.error_count,
    })
  }

  return [...byDateAccount.values()].sort((a, b) => {
    if (a.date === b.date) return a.account_id.localeCompare(b.account_id)
    return a.date.localeCompare(b.date)
  })
}
