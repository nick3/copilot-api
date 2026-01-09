import { expect, test } from "bun:test"

import { resetCopilotRateLimitersForTest } from "../src/lib/copilot-rate-limiter"
import { HTTPError } from "../src/lib/error"
import {
  copilotFetchEventsWithRetry,
  copilotFetchJsonWithRetry,
} from "../src/lib/resilient-copilot-fetch"
import { state } from "../src/lib/state"

function getChunkData(chunk: unknown): string | Promise<string> | undefined {
  const obj = chunk as { data?: string | Promise<string> }
  return obj.data
}

function immediateSleep(): Promise<void> {
  return Promise.resolve()
}

function installMockFetch(mock: typeof fetch): () => void {
  const realFetch = globalThis.fetch

  globalThis.fetch = mock

  return () => {
    globalThis.fetch = realFetch
  }
}

test("copilotFetchJsonWithRetry retries once on 503 then returns JSON", async () => {
  state.rateLimitSeconds = undefined
  resetCopilotRateLimitersForTest()

  let callCount = 0

  const restore = installMockFetch(((..._args) => {
    callCount += 1

    if (callCount === 1) {
      return Promise.resolve(new Response("transient", { status: 503 }))
    }

    return Promise.resolve(Response.json({ ok: true }, { status: 200 }))
  }) as typeof fetch)

  try {
    const result = await copilotFetchJsonWithRetry<{ ok: boolean }>({
      accountId: "acct",
      operation: "POST /test",
      url: "http://unit-test.local/json",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      failureMessage: "Failed to fetch JSON",
      maxRetries: 1,
      timeoutMs: 1000,
      sleep: immediateSleep,
    })

    expect(result).toEqual({ ok: true })
    expect(callCount).toBe(2)
  } finally {
    restore()
  }
})

test("copilotFetchJsonWithRetry throws HTTPError on non-retryable status", async () => {
  state.rateLimitSeconds = undefined
  resetCopilotRateLimitersForTest()

  let callCount = 0

  const restore = installMockFetch(((..._args) => {
    callCount += 1
    return Promise.resolve(new Response("bad request", { status: 400 }))
  }) as typeof fetch)

  try {
    let thrown: unknown

    try {
      await copilotFetchJsonWithRetry({
        accountId: "acct",
        operation: "POST /test",
        url: "http://unit-test.local/bad",
        init: { method: "POST" },
        failureMessage: "Failed",
        maxRetries: 1,
        timeoutMs: 1000,
        sleep: immediateSleep,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HTTPError)
    expect(callCount).toBe(1)
  } finally {
    restore()
  }
})

test("copilotFetchEventsWithRetry retries when stream ends before first event", async () => {
  state.rateLimitSeconds = undefined
  resetCopilotRateLimitersForTest()

  let callCount = 0

  const restore = installMockFetch(((..._args) => {
    callCount += 1

    // First attempt: stream ends immediately (no events)
    if (callCount === 1) {
      return Promise.resolve(
        new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }

    // Second attempt: valid first event
    const sse = "event: message\ndata: hello\n\n"
    return Promise.resolve(
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    )
  }) as typeof fetch)

  try {
    const stream = await copilotFetchEventsWithRetry({
      accountId: "acct",
      operation: "POST /stream",
      url: "http://unit-test.local/stream",
      init: { method: "POST" },
      failureMessage: "Failed to fetch stream",
      maxRetries: 1,
      connectTimeoutMs: 1000,
      firstEventTimeoutMs: 1000,
      sleep: immediateSleep,
    })

    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.done).toBe(false)

    const rawData = getChunkData(first.value)

    let data = ""
    if (typeof rawData === "string") {
      data = rawData
    } else if (rawData) {
      data = await rawData
    }

    expect(data).toContain("hello")
    expect(callCount).toBe(2)
  } finally {
    restore()
  }
})
