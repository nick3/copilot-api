import {
  getCreditsConsumed,
  type DailyAccountStatsItem,
  type DailyAccountStatsItemWire,
  type DailyStatsItem,
  type DailyStatsItemWire,
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

function accumulateDailyStats(
  target: DailyStatsItem,
  item: DailyStatsItemWire,
): void {
  const creditsConsumed = getCreditsConsumed(item)

  target.request_count += item.request_count
  target.credits_consumed += creditsConsumed
  target.premium_consumed = target.credits_consumed
  target.tokens_total += item.tokens_total
  target.error_count += item.error_count
}

function createDailyStats(
  date: string,
  item: DailyStatsItemWire,
): DailyStatsItem {
  const creditsConsumed = getCreditsConsumed(item)

  return {
    date,
    request_count: item.request_count,
    premium_consumed: creditsConsumed,
    credits_consumed: creditsConsumed,
    tokens_total: item.tokens_total,
    error_count: item.error_count,
  }
}

export function aggregateHourlyStatsToLocalDays(
  items: readonly DailyStatsItemWire[],
  timeZone?: string,
): Array<DailyStatsItem> {
  const byDate = new Map<string, DailyStatsItem>()

  for (const item of items) {
    const date = getLocalDayKey(item.date, timeZone)
    const existing = byDate.get(date)
    if (existing) {
      accumulateDailyStats(existing, item)
      continue
    }

    byDate.set(date, createDailyStats(date, item))
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function aggregateHourlyAccountStatsToLocalDays(
  items: readonly DailyAccountStatsItemWire[],
  timeZone?: string,
): Array<DailyAccountStatsItem> {
  const byDateAccount = new Map<string, DailyAccountStatsItem>()

  for (const item of items) {
    const date = getLocalDayKey(item.date, timeZone)
    const key = `${date}|${item.account_id}`
    const existing = byDateAccount.get(key)
    if (existing) {
      accumulateDailyStats(existing, item)
      continue
    }

    byDateAccount.set(key, {
      ...createDailyStats(date, item),
      account_id: item.account_id,
    })
  }

  return [...byDateAccount.values()].sort((a, b) => {
    if (a.date === b.date) return a.account_id.localeCompare(b.account_id)
    return a.date.localeCompare(b.date)
  })
}
