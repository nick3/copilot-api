export const UPSTREAM_TRANSPORT_FIELDS = [
  "headersTimeoutMs",
  "streamInactivityTimeoutMs",
  "websocketOpenTimeoutMs",
  "websocketPoolIdleTimeoutMs",
  "websocketMaxBufferedBytes",
  "websocketMaxBufferedMessages",
] as const

export type UpstreamTransportSettings = Partial<
  Record<(typeof UPSTREAM_TRANSPORT_FIELDS)[number], number>
>

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function validateUpstreamTransport(value: unknown): string | undefined {
  if (!isObject(value)) return "upstreamTransport must be an object"
  for (const [key, entry] of Object.entries(value)) {
    if (!UPSTREAM_TRANSPORT_FIELDS.some((field) => field === key)) {
      return `upstreamTransport.${key} is not supported`
    }
    if (
      typeof entry !== "number"
      || !Number.isSafeInteger(entry)
      || entry <= 0
    ) {
      return `upstreamTransport.${key} must be a positive integer`
    }
    // Timers in both runtimes are limited to a signed 32-bit delay.
    if (key.endsWith("Ms") && entry > 2_147_483_647) {
      return `upstreamTransport.${key} exceeds the maximum timer delay`
    }
  }
}

export function validatePeakPricing(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (value.offPeak !== undefined) {
    if (!isObject(value.offPeak)) return `${field}.offPeak must be an object`
    const priceFields = new Set([
      "cachedInput",
      "cacheCreationInput",
      "explicitCachedInput",
      "input",
      "maxInputTokens",
      "output",
    ])
    for (const [key, price] of Object.entries(value.offPeak)) {
      if (!priceFields.has(key))
        return `${field}.offPeak.${key} is not supported`
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
        return `${field}.offPeak.${key} must be a non-negative number`
      }
    }
  }
  if (value.peakWindows === undefined) return
  if (!Array.isArray(value.peakWindows))
    return `${field}.peakWindows must be an array`
  for (const [index, window] of value.peakWindows.entries()) {
    const path = `${field}.peakWindows[${index}]`
    if (!isObject(window)) return `${path} must be an object`
    for (const key of Object.keys(window)) {
      if (!["startMinuteUtc", "endMinuteUtc", "weekdays"].includes(key)) {
        return `${path}.${key} is not supported`
      }
    }
    for (const key of ["startMinuteUtc", "endMinuteUtc"] as const) {
      const minute = window[key]
      const limit = key === "startMinuteUtc" ? 1439 : 1440
      if (
        typeof minute !== "number"
        || !Number.isInteger(minute)
        || minute < 0
        || minute > limit
      ) {
        return `${path}.${key} must be a UTC minute between 0 and ${limit}`
      }
    }
    if (
      window.weekdays !== undefined
      && (!Array.isArray(window.weekdays)
        || window.weekdays.some(
          (day: unknown) =>
            typeof day !== "number"
            || !Number.isInteger(day)
            || day < 1
            || day > 7,
        ))
    )
      return `${path}.weekdays must contain ISO weekdays 1 to 7`
  }
}
