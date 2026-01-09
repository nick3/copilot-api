import type { Context, MiddlewareHandler } from "hono"

import { getCopilotRateLimiter } from "./copilot-rate-limiter"
import { state } from "./state"

type ApplyOptions = {
  accountId?: string
}

function clampLimitPerMinute(limit: number): number {
  // Avoid confusing clients with 0 req/min when interval > 60s.
  return Math.max(1, limit)
}

export function applyRateLimitHeaders(
  c: Context,
  options: ApplyOptions = {},
): void {
  const configuredSeconds = state.rateLimitSeconds

  // Unlimited mode
  if (configuredSeconds === undefined) {
    c.header("X-RateLimit-Limit", "unlimited")
    c.header("X-RateLimit-Remaining", "unlimited")
    c.header("X-RateLimit-Reset", "unlimited")
    c.header("X-Queue-Depth", "0")
    return
  }

  const accountId = options.accountId?.trim()

  // Best-effort fallback when we don't know which Copilot account will be used.
  if (!accountId) {
    const limit = clampLimitPerMinute(Math.floor(60 / configuredSeconds))
    const reset = Math.floor((Date.now() + configuredSeconds * 1000) / 1000)

    c.header("X-RateLimit-Limit", String(limit))
    c.header("X-RateLimit-Remaining", String(limit))
    c.header("X-RateLimit-Reset", String(reset))
    c.header("X-Queue-Depth", "0")
    return
  }

  const snapshot = getCopilotRateLimiter(accountId).snapshot()
  const effectiveSeconds = snapshot.effectiveSeconds ?? configuredSeconds

  const limit = clampLimitPerMinute(Math.floor(60 / effectiveSeconds))
  const remaining = Math.max(0, limit - snapshot.queueDepth)
  const reset = Math.floor(snapshot.nextAllowedAtMs / 1000)

  c.header("X-RateLimit-Limit", String(limit))
  c.header("X-RateLimit-Remaining", String(remaining))
  c.header("X-RateLimit-Reset", String(reset))
  c.header("X-Queue-Depth", String(snapshot.queueDepth))

  if (snapshot.queueDepth > 50) {
    c.header("Retry-After", String(effectiveSeconds))
  }
}

export function rateLimitHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    applyRateLimitHeaders(c)
    await next()
  }
}
