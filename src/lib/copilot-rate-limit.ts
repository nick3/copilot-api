import consola from "consola"

const copilotRateLimitTypes = ["session", "weekly"] as const

export type CopilotRateLimitType = (typeof copilotRateLimitTypes)[number]
type HeadersMap = Record<string, string | undefined>
type HeadersLike = Headers | HeadersMap

export interface CopilotRateLimitUsage {
  type: CopilotRateLimitType
  remaining: string
  resetAt: string
}

const copilotRateLimitHeaders: Record<CopilotRateLimitType, string> = {
  session: "x-usage-ratelimit-session",
  weekly: "x-usage-ratelimit-weekly",
}

const hasGetMethod = (headers: HeadersLike): headers is Headers => {
  return "get" in headers && typeof headers.get === "function"
}

const getHeaderValue = (
  headers: HeadersLike,
  headerName: string,
): string | null => {
  if (hasGetMethod(headers)) {
    return headers.get(headerName)
  }

  const normalizedHeaderName = headerName.toLowerCase()
  const matchedEntry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedHeaderName,
  )

  return matchedEntry?.[1] ?? null
}

export const parseCopilotRateLimitHeader = (
  headerValue: string,
): Omit<CopilotRateLimitUsage, "type"> | null => {
  const params = new URLSearchParams(headerValue)
  const remaining = params.get("rem")
  const resetAt = params.get("rst")

  if (!remaining || !resetAt) {
    return null
  }

  return {
    remaining,
    resetAt,
  }
}

export const getCopilotRateLimitUsage = (
  headers: HeadersLike,
  type: CopilotRateLimitType,
): CopilotRateLimitUsage | null => {
  const headerName = copilotRateLimitHeaders[type]
  const headerValue = getHeaderValue(headers, headerName)

  if (!headerValue) {
    return null
  }

  const parsed = parseCopilotRateLimitHeader(headerValue)

  if (!parsed) {
    return null
  }

  return {
    type,
    ...parsed,
  }
}

export const logCopilotRateLimits = (headers: HeadersLike): void => {
  for (const type of copilotRateLimitTypes) {
    const usage = getCopilotRateLimitUsage(headers, type)

    if (!usage) {
      continue
    }

    const d = new Date(usage.resetAt)
    const dateStr =
      Number.isNaN(d.getTime()) ? usage.resetAt : d.toLocaleString()
    consola.info(
      `Copilot ${usage.type} quota remaining: ${usage.remaining}, resets at: ${dateStr}`,
    )
  }
}
