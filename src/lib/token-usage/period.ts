import type { TokenUsagePeriod } from "./store"
export const TOKEN_USAGE_PERIODS = [
  "today",
  "this_week",
  "last_7_days",
  "this_month",
  "last_30_days",
  "lifetime",
] as const
const legacy: Record<string, TokenUsagePeriod> = {
  day: "today",
  week: "last_7_days",
  month: "last_30_days",
}
export function parseTokenUsagePeriod(
  value: string | null | undefined,
): TokenUsagePeriod {
  return TOKEN_USAGE_PERIODS.some((period) => period === value) ?
      (value as TokenUsagePeriod)
    : ((value ? legacy[value] : undefined) ?? "today")
}
