import { afterEach, expect, test } from "bun:test"

import { CopilotRateLimiter } from "../src/lib/copilot-rate-limiter"
import { state } from "../src/lib/state"

afterEach(() => {
  // Avoid leaking config across tests.
  state.rateLimitSeconds = undefined
})

test("acquire is a no-op when rate limiting is disabled", async () => {
  state.rateLimitSeconds = undefined

  let slept = false

  const limiter = new CopilotRateLimiter("acct", {
    nowMs: () => 0,
    sleep: () => {
      slept = true
      return Promise.resolve()
    },
  })

  await limiter.acquire()

  expect(slept).toBe(false)
  expect(limiter.snapshot()).toEqual({
    enabled: false,
    queueDepth: 0,
    nextAllowedAtMs: 0,
  })
})

test("acquire enforces the configured interval", async () => {
  state.rateLimitSeconds = 1

  let now = 0
  const sleeps: Array<number> = []

  const limiter = new CopilotRateLimiter("acct", {
    nowMs: () => now,
    sleep: (ms) => {
      sleeps.push(ms)
      now += ms
      return Promise.resolve()
    },
  })

  await Promise.all([limiter.acquire(), limiter.acquire()])

  expect(sleeps).toEqual([1000])
})

test("noteRateLimitHit increases effective interval and enforces cooldown", async () => {
  state.rateLimitSeconds = 1

  let now = 0
  const sleeps: Array<number> = []

  const limiter = new CopilotRateLimiter("acct", {
    nowMs: () => now,
    sleep: (ms) => {
      sleeps.push(ms)
      now += ms
      return Promise.resolve()
    },
  })

  limiter.noteRateLimitHit(5, 5000)

  expect(limiter.snapshot()).toEqual({
    enabled: true,
    effectiveSeconds: 5,
    queueDepth: 0,
    nextAllowedAtMs: 5000,
  })

  await limiter.acquire()

  expect(sleeps).toEqual([5000])
})
