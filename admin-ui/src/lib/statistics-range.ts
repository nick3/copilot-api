export type StatisticsTimePreset = "today" | "7d" | "month" | "custom"

export type StatisticsRange = {
  from: string
  to: string
  granularity: "day" | "hour"
}

function toDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
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
    return { from: today, to: today, granularity: "hour" }
  }

  if (preset === "7d") {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
    return { from: toDateString(weekAgo), to: today, granularity: "day" }
  }

  if (preset === "month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    return { from: toDateString(startOfMonth), to: today, granularity: "day" }
  }

  return {
    from: customFrom || today,
    to: customTo || today,
    granularity: "day",
  }
}
