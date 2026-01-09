import type { Context } from "hono"

import { expect, test } from "bun:test"

import {
  getCopilotRateLimiter,
  resetCopilotRateLimitersForTest,
} from "../src/lib/copilot-rate-limiter"
import { applyRateLimitHeaders } from "../src/lib/rate-limit-headers"
import { state } from "../src/lib/state"

class TestContext {
  readonly headers = new Headers()

  header(name: string, value: string) {
    this.headers.set(name, value)
  }
}

test("applyRateLimitHeaders sets unlimited headers when rate limiting is disabled", () => {
  state.rateLimitSeconds = undefined
  resetCopilotRateLimitersForTest()

  const c = new TestContext()
  applyRateLimitHeaders(c as unknown as Context)

  expect(c.headers.get("X-RateLimit-Limit")).toBe("unlimited")
  expect(c.headers.get("X-RateLimit-Remaining")).toBe("unlimited")
  expect(c.headers.get("X-RateLimit-Reset")).toBe("unlimited")
  expect(c.headers.get("X-Queue-Depth")).toBe("0")
})

test("applyRateLimitHeaders falls back when accountId is not known", () => {
  state.rateLimitSeconds = 2
  resetCopilotRateLimitersForTest()

  const realNow = Date.now
  Date.now = () => 1000

  try {
    const c = new TestContext()
    applyRateLimitHeaders(c as unknown as Context)

    expect(c.headers.get("X-RateLimit-Limit")).toBe("30")
    expect(c.headers.get("X-RateLimit-Remaining")).toBe("30")
    expect(c.headers.get("X-RateLimit-Reset")).toBe("3")
    expect(c.headers.get("X-Queue-Depth")).toBe("0")
  } finally {
    Date.now = realNow
  }
})

test("applyRateLimitHeaders uses per-account limiter snapshot when accountId is provided", () => {
  state.rateLimitSeconds = 1
  resetCopilotRateLimitersForTest()

  const realNow = Date.now
  Date.now = () => 1000

  try {
    const limiter = getCopilotRateLimiter("acct")
    limiter.noteRateLimitHit(10, 5000)

    const c = new TestContext()
    applyRateLimitHeaders(c as unknown as Context, { accountId: "acct" })

    // effectiveSeconds = max(configured=1, learned=10) = 10 => floor(60/10)=6
    expect(c.headers.get("X-RateLimit-Limit")).toBe("6")
    expect(c.headers.get("X-RateLimit-Remaining")).toBe("6")
    // cooldownUntilMs = now(1000)+5000 => 6000 => reset=6
    expect(c.headers.get("X-RateLimit-Reset")).toBe("6")
    expect(c.headers.get("X-Queue-Depth")).toBe("0")
  } finally {
    Date.now = realNow
  }
})

test("applyRateLimitHeaders sets Retry-After when queue depth is high", async () => {
  state.rateLimitSeconds = 1
  resetCopilotRateLimitersForTest()

  const limiter = getCopilotRateLimiter("acct")

  // Override internals to avoid real timers.
  let now = 0
  const hacked = limiter as unknown as {
    nowMs: () => number
    sleep: (ms: number) => Promise<void>
  }
  hacked.nowMs = () => now
  hacked.sleep = (ms) => {
    now += ms
    return Promise.resolve()
  }

  const acquires = Array.from({ length: 51 }, () => limiter.acquire())

  const c = new TestContext()
  applyRateLimitHeaders(c as unknown as Context, { accountId: "acct" })

  expect(Number(c.headers.get("X-Queue-Depth"))).toBeGreaterThan(50)
  expect(c.headers.get("Retry-After")).toBe("1")

  await Promise.all(acquires)
})
