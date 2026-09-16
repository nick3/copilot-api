// Peak-pricing windows published by upstream providers that bill different
// prices during peak hours. Windows are expressed in UTC minutes and ISO
// weekdays so a schedule applies no matter which timezone the host runs in.

export interface TokenUsagePeakWindow {
  // Exclusive end of the peak window, in minutes from 00:00 UTC.
  endMinuteUtc: number
  // Inclusive start of the peak window, in minutes from 00:00 UTC.
  startMinuteUtc: number
  // ISO weekday numbers, 1 = Monday ... 7 = Sunday. Omitted means every day.
  weekdays?: Array<number>
}

// DeepSeek bills peak prices on Beijing time 09:00-12:00 and 14:00-18:00 from
// Monday to Friday, which is UTC 01:00-04:00 and 06:00-10:00. Weekends and
// every other hour are off-peak. OpenCode Go publishes the same windows for
// its DeepSeek models.
export const deepseekPeakWindows: Array<TokenUsagePeakWindow> = [
  { endMinuteUtc: 4 * 60, startMinuteUtc: 60, weekdays: [1, 2, 3, 4, 5] },
  { endMinuteUtc: 10 * 60, startMinuteUtc: 6 * 60, weekdays: [1, 2, 3, 4, 5] },
]

// DashScope bills DeepSeek models off-peak on Beijing time 22:00-08:00, which
// is UTC 14:00-24:00, so the remaining UTC hours of every day are peak.
export const dashscopePeakWindows: Array<TokenUsagePeakWindow> = [
  { endMinuteUtc: 14 * 60, startMinuteUtc: 0 },
]
