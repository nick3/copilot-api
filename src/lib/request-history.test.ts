import type { Context } from "hono"

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"
import type {
  ResponseStreamEvent,
  ResponseUsage,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import { initAdminDb } from "~/lib/admin-db"
import {
  RequestHistoryStore,
  extractResponsesUsageFromResult,
  extractResponsesUsageFromStreamEvent,
  getClientIpInfo,
  normalizeChatCompletionsUsage,
  normalizeEmbeddingsUsage,
  normalizeResponsesUsage,
} from "~/lib/request-history"

describe("normalizeChatCompletionsUsage", () => {
  test("subtracts cached prompt tokens", () => {
    const usage: ChatCompletionResponse["usage"] = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: {
        cached_tokens: 30,
      },
    }

    expect(normalizeChatCompletionsUsage(usage)).toEqual({
      tokensCachedInput: 30,
      tokensInput: 70,
      tokensOutput: 20,
      tokensTotal: 120,
      usageJson: JSON.stringify(usage),
    })
  })

  test("works with streaming chunk usage", () => {
    const usage: ChatCompletionChunk["usage"] = {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: {
        cached_tokens: 0,
      },
    }

    expect(normalizeChatCompletionsUsage(usage).tokensTotal).toBe(12)
  })
})

describe("normalizeResponsesUsage", () => {
  test("subtracts cached input tokens", () => {
    const usage: ResponseUsage = {
      input_tokens: 50,
      output_tokens: 10,
      total_tokens: 60,
      input_tokens_details: {
        cached_tokens: 20,
      },
    }

    expect(normalizeResponsesUsage(usage)).toEqual({
      tokensCachedInput: 20,
      tokensInput: 30,
      tokensOutput: 10,
      tokensTotal: 60,
      usageJson: JSON.stringify(usage),
    })
  })
})

describe("normalizeEmbeddingsUsage", () => {
  test("maps embedding usage", () => {
    const usage: EmbeddingResponse["usage"] = {
      prompt_tokens: 7,
      total_tokens: 7,
    }

    expect(normalizeEmbeddingsUsage(usage)).toEqual({
      tokensCachedInput: 0,
      tokensInput: 7,
      tokensOutput: 0,
      tokensTotal: 7,
      usageJson: JSON.stringify(usage),
    })
  })
})

describe("extractResponsesUsageFromStreamEvent", () => {
  test("reads usage from response.completed", () => {
    const usage: ResponseUsage = {
      input_tokens: 5,
      output_tokens: 1,
      total_tokens: 6,
      input_tokens_details: { cached_tokens: 2 },
    }

    const event = {
      type: "response.completed",
      sequence_number: 1,
      response: {
        usage,
      },
    } as ResponseStreamEvent

    expect(extractResponsesUsageFromStreamEvent(event).tokensTotal).toBe(6)
    expect(extractResponsesUsageFromStreamEvent(event).tokensInput).toBe(3)
  })
})

describe("extractResponsesUsageFromResult", () => {
  test("reads usage from result", () => {
    const usage: ResponseUsage = {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 0 },
    }

    const result = {
      usage,
    } as ResponsesResult

    expect(extractResponsesUsageFromResult(result).tokensOutput).toBe(4)
  })
})

describe("getClientIpInfo", () => {
  test("prefers cf-connecting-ip", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "cf-connecting-ip") return "203.0.113.1"
          return undefined
        },
      },
    } as unknown as Context

    expect(getClientIpInfo(c)).toEqual({
      ip: "203.0.113.1",
      source: "cf-connecting-ip",
    })
  })

  test("uses first x-forwarded-for", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "x-forwarded-for") {
            return "198.51.100.10, 198.51.100.11"
          }
          return undefined
        },
      },
    } as unknown as Context

    expect(getClientIpInfo(c)).toEqual({
      ip: "198.51.100.10",
      source: "x-forwarded-for",
    })
  })

  test("falls back to x-real-ip", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "x-real-ip") return "192.0.2.9"
          return undefined
        },
      },
    } as unknown as Context

    expect(getClientIpInfo(c)).toEqual({ ip: "192.0.2.9", source: "x-real-ip" })
  })
})

describe("RequestHistoryStore", () => {
  test("insert + getByRequestId", () => {
    const db = new Database(":memory:")
    initAdminDb(db)

    const store = new RequestHistoryStore(db)

    store.insert({
      requestId: "r1",
      startedAtMs: 1000,
      finishedAtMs: 1100,
      durationMs: 100,
      method: "POST",
      path: "/v1/messages",
      upstreamEndpoint: "/responses",
      stream: false,
      accountId: "acct-1",
      accountType: "premium",
      costUnits: 1,
      clientModel: "claude-3.5",
      upstreamModel: "gpt-5",
      clientIp: "203.0.113.9",
      clientIpSource: "x-forwarded-for",
      userAgent: "ua",
      tokensInput: 10,
      tokensOutput: 20,
      tokensTotal: 30,
      tokensCachedInput: 0,
      usageJson: "{}",
      premiumRemainingBefore: 100,
      premiumRemainingAfter: 90,
      premiumRemainingDiff: -10,
      premiumUnlimitedBefore: false,
      premiumUnlimitedAfter: false,
      httpStatus: 200,
    })

    const row = store.getByRequestId("r1")
    expect(row?.request_id).toBe("r1")
    expect(row?.path).toBe("/v1/messages")
    expect(row?.account_id).toBe("acct-1")
    expect(row?.stream).toBe(0)
    expect(row?.premium_unlimited_before).toBe(0)
  })

  test("query orders by id DESC and supports cursor paging", () => {
    const db = new Database(":memory:")
    initAdminDb(db)

    const store = new RequestHistoryStore(db)

    for (const id of ["r1", "r2", "r3"]) {
      store.insert({
        requestId: id,
        startedAtMs: 1000,
        method: "POST",
        path: "/v1/messages",
        stream: false,
        httpStatus: 200,
      })
    }

    const page1 = store.query({ limit: 2 })
    expect(page1.items.map((r) => r.request_id)).toEqual(["r3", "r2"])
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursorId).toBeDefined()

    const page2 = store.query({ limit: 10, cursorId: page1.nextCursorId })
    expect(page2.items.map((r) => r.request_id)).toEqual(["r1"])
    expect(page2.hasMore).toBe(false)
  })

  test("filters by account_id and status", () => {
    const db = new Database(":memory:")
    initAdminDb(db)

    const store = new RequestHistoryStore(db)

    store.insert({
      requestId: "ok",
      startedAtMs: 1,
      method: "POST",
      path: "/v1/messages",
      stream: false,
      accountId: "a1",
      httpStatus: 200,
    })

    store.insert({
      requestId: "bad",
      startedAtMs: 2,
      method: "POST",
      path: "/v1/messages",
      stream: false,
      accountId: "a1",
      httpStatus: 500,
    })

    store.insert({
      requestId: "other",
      startedAtMs: 3,
      method: "POST",
      path: "/v1/messages",
      stream: false,
      accountId: "a2",
      httpStatus: 200,
    })

    const q1 = store.query({ limit: 50, accountId: "a1" })
    expect(q1.items.map((r) => r.request_id).sort()).toEqual(["bad", "ok"])

    const q2 = store.query({ limit: 50, accountId: "a1", status: 500 })
    expect(q2.items.map((r) => r.request_id)).toEqual(["bad"])
  })

  test("getAccountStatsSince aggregates counts and tokens", () => {
    const db = new Database(":memory:")
    initAdminDb(db)

    const store = new RequestHistoryStore(db)

    store.insert({
      requestId: "r1",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      durationMs: 100,
      method: "POST",
      path: "/v1/messages",
      stream: false,
      accountId: "a1",
      tokensTotal: 10,
      httpStatus: 200,
    })

    store.insert({
      requestId: "r2",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      durationMs: 200,
      method: "POST",
      path: "/v1/messages",
      stream: false,
      accountId: "a1",
      tokensTotal: 5,
      httpStatus: 500,
    })

    const stats = store.getAccountStatsSince(Date.now() - 60_000)
    expect(stats.a1?.request_count).toBe(2)
    expect(stats.a1?.error_count).toBe(1)
    expect(stats.a1?.tokens_total).toBe(15)
  })

  test("cleanupRetention enforces maxRows", () => {
    const db = new Database(":memory:")
    initAdminDb(db)

    const store = new RequestHistoryStore(db)

    for (let i = 0; i < 5; i++) {
      store.insert({
        requestId: `r${i}`,
        startedAtMs: 1,
        method: "POST",
        path: "/v1/messages",
        stream: false,
        httpStatus: 200,
      })
    }

    store.cleanupRetention(99999, 2)

    const after = store.query({ limit: 50 })
    expect(after.items.length).toBe(2)
  })
})

test("normalizeChatCompletionsUsage handles missing prompt_tokens_details", () => {
  const usage: ChatCompletionResponse["usage"] = {
    prompt_tokens: 50,
    completion_tokens: 10,
    total_tokens: 60,
  }

  const result = normalizeChatCompletionsUsage(usage)

  expect(result.tokensCachedInput).toBe(0)
  expect(result.tokensInput).toBe(50)
})

test("normalizeChatCompletionsUsage returns empty object for undefined", () => {
  expect(normalizeChatCompletionsUsage(undefined)).toEqual({})
})

test("normalizeResponsesUsage handles missing output_tokens", () => {
  const usage: ResponseUsage = {
    input_tokens: 10,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
  }

  const result = normalizeResponsesUsage(usage)

  expect(result.tokensOutput).toBe(0)
})

test("normalizeResponsesUsage returns empty object for null", () => {
  expect(normalizeResponsesUsage(null)).toEqual({})
})

test("normalizeEmbeddingsUsage returns empty for undefined", () => {
  expect(normalizeEmbeddingsUsage(undefined)).toEqual({})
})

test("getClientIpInfo returns empty object when no headers", () => {
  const c = {
    req: {
      header: () => undefined,
    },
  } as unknown as Context

  expect(getClientIpInfo(c)).toEqual({})
})

test("getClientIpInfo handles empty x-forwarded-for", () => {
  const c = {
    req: {
      header: (name: string) => {
        if (name.toLowerCase() === "x-forwarded-for") return ""
        return undefined
      },
    },
  } as unknown as Context

  expect(getClientIpInfo(c)).toEqual({})
})

test("getClientIpInfo trims whitespace from IPs", () => {
  const c = {
    req: {
      header: (name: string) => {
        if (name.toLowerCase() === "x-real-ip") return "  192.0.2.1  "
        return undefined
      },
    },
  } as unknown as Context

  expect(getClientIpInfo(c)).toEqual({
    ip: "192.0.2.1",
    source: "x-real-ip",
  })
})

test("extractResponsesUsageFromStreamEvent returns empty for non-completed events", () => {
  const event = {
    type: "response.text.delta",
    sequence_number: 1,
  } as ResponseStreamEvent

  expect(extractResponsesUsageFromStreamEvent(event)).toEqual({})
})

test("extractResponsesUsageFromResult returns empty when result has no usage", () => {
  const result = {
    id: "test",
  } as ResponsesResult

  expect(extractResponsesUsageFromResult(result)).toEqual({})
})

test("RequestHistoryStore insert handles minimal record", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "minimal",
    startedAtMs: Date.now(),
    method: "GET",
    path: "/test",
    stream: false,
  })

  const row = store.getByRequestId("minimal")
  expect(row?.request_id).toBe("minimal")
  expect(row?.method).toBe("GET")
})

test("RequestHistoryStore getByRequestId returns null for non-existent", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  expect(store.getByRequestId("nonexistent")).toBeNull()
})

test("RequestHistoryStore query respects limit parameter", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  for (let i = 0; i < 10; i++) {
    store.insert({
      requestId: `r${i}`,
      startedAtMs: i,
      method: "POST",
      path: "/test",
      stream: false,
    })
  }

  const result = store.query({ limit: 3 })

  expect(result.items.length).toBe(3)
})

test("RequestHistoryStore query clamps limit to max 200", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  for (let i = 0; i < 5; i++) {
    store.insert({
      requestId: `r${i}`,
      startedAtMs: i,
      method: "POST",
      path: "/test",
      stream: false,
    })
  }

  const result = store.query({ limit: 500 })

  expect(result.items.length).toBeLessThanOrEqual(200)
})

test("RequestHistoryStore query filters by upstreamModel", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "r1",
    startedAtMs: 1,
    method: "POST",
    path: "/test",
    stream: false,
    upstreamModel: "gpt-4",
  })

  store.insert({
    requestId: "r2",
    startedAtMs: 2,
    method: "POST",
    path: "/test",
    stream: false,
    upstreamModel: "gpt-5",
  })

  const result = store.query({ limit: 50, upstreamModel: "gpt-5" })

  expect(result.items.length).toBe(1)
  expect(result.items[0].request_id).toBe("r2")
})

test("RequestHistoryStore query filters by clientModel", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "r1",
    startedAtMs: 1,
    method: "POST",
    path: "/test",
    stream: false,
    clientModel: "claude-3.5",
  })

  store.insert({
    requestId: "r2",
    startedAtMs: 2,
    method: "POST",
    path: "/test",
    stream: false,
    clientModel: "gpt-4",
  })

  const result = store.query({ limit: 50, clientModel: "claude-3.5" })

  expect(result.items.length).toBe(1)
  expect(result.items[0].request_id).toBe("r1")
})

test("RequestHistoryStore query filters by upstreamEndpoint", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "r1",
    startedAtMs: 1,
    method: "POST",
    path: "/test",
    stream: false,
    upstreamEndpoint: "/chat/completions",
  })

  store.insert({
    requestId: "r2",
    startedAtMs: 2,
    method: "POST",
    path: "/test",
    stream: false,
    upstreamEndpoint: "/responses",
  })

  const result = store.query({ limit: 50, upstreamEndpoint: "/responses" })

  expect(result.items.length).toBe(1)
  expect(result.items[0].request_id).toBe("r2")
})

test("RequestHistoryStore query filters by path", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "r1",
    startedAtMs: 1,
    method: "POST",
    path: "/v1/messages",
    stream: false,
  })

  store.insert({
    requestId: "r2",
    startedAtMs: 2,
    method: "POST",
    path: "/v1/chat/completions",
    stream: false,
  })

  const result = store.query({ limit: 50, path: "/v1/messages" })

  expect(result.items.length).toBe(1)
  expect(result.items[0].request_id).toBe("r1")
})

test("RequestHistoryStore query filters by hasError=true", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "ok",
    startedAtMs: 1,
    method: "POST",
    path: "/test",
    stream: false,
  })

  store.insert({
    requestId: "error",
    startedAtMs: 2,
    method: "POST",
    path: "/test",
    stream: false,
    errorName: "Error",
    errorMessage: "boom",
  })

  const result = store.query({ limit: 50, hasError: true })

  expect(result.items.length).toBe(1)
  expect(result.items[0].request_id).toBe("error")
})

test("RequestHistoryStore query filters by hasError=false", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "ok",
    startedAtMs: 1,
    method: "POST",
    path: "/test",
    stream: false,
  })

  store.insert({
    requestId: "error",
    startedAtMs: 2,
    method: "POST",
    path: "/test",
    stream: false,
    errorName: "Error",
  })

  const result = store.query({ limit: 50, hasError: false })

  expect(result.items.length).toBe(1)
  expect(result.items[0].request_id).toBe("ok")
})

test("RequestHistoryStore query filters by time range", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "r1",
    startedAtMs: 1000,
    method: "POST",
    path: "/test",
    stream: false,
  })

  store.insert({
    requestId: "r2",
    startedAtMs: 2000,
    method: "POST",
    path: "/test",
    stream: false,
  })

  store.insert({
    requestId: "r3",
    startedAtMs: 3000,
    method: "POST",
    path: "/test",
    stream: false,
  })

  const result = store.query({ limit: 50, fromMs: 1500, toMs: 2500 })

  expect(result.items.length).toBe(1)
  expect(result.items[0].request_id).toBe("r2")
})

test("RequestHistoryStore getAccountStatsSince handles missing duration", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  store.insert({
    requestId: "r1",
    startedAtMs: Date.now(),
    method: "POST",
    path: "/test",
    stream: false,
    accountId: "a1",
  })

  const stats = store.getAccountStatsSince(Date.now() - 60_000)

  expect(stats.a1?.request_count).toBe(1)
  expect(stats.a1?.avg_duration_ms).toBe(0)
})

test("RequestHistoryStore cleanupRetention enforces retention days", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  const oldTime = Date.now() - 15 * 24 * 60 * 60 * 1000
  const newTime = Date.now()

  store.insert({
    requestId: "old",
    startedAtMs: oldTime,
    method: "POST",
    path: "/test",
    stream: false,
  })

  store.insert({
    requestId: "new",
    startedAtMs: newTime,
    method: "POST",
    path: "/test",
    stream: false,
  })

  store.cleanupRetention(14, 999999)

  const result = store.query({ limit: 50 })

  expect(result.items.length).toBe(1)
  expect(result.items[0].request_id).toBe("new")
})

test("RequestHistoryStore meta returns expected structure", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = new RequestHistoryStore(db)

  const meta = store.meta()

  expect(meta.dbPath).toBeDefined()
  expect(meta.schemaVersion).toBe(1)
  expect(meta.retentionDays).toBeDefined()
  expect(meta.maxRows).toBeDefined()
})
