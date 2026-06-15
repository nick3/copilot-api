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
  captureOutboundHeadersSnapshot,
  requestContext,
} from "~/lib/request-context"
import {
  RequestHistoryStore,
  toAdminRequestLogRow,
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
      isSubagent: true,
      affinityKeyUsed: "session-key-1",
      affinityKeySource: "x_session_id",
      selectionReason: "affinity_miss",
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
      upstreamErrorMessageRaw: "test error body",
    })

    const row = store.getByRequestId("r1")
    const adminRow = row ? toAdminRequestLogRow(row) : null
    expect(row?.request_id).toBe("r1")
    expect(adminRow?.credits_consumed).toBe(1)
    expect(adminRow?.credits_remaining_before).toBe(100)
    expect(adminRow?.credits_remaining_after).toBe(90)
    expect(adminRow?.credits_remaining_diff).toBe(-10)
    expect(adminRow?.credits_unlimited_before).toBe(0)
    expect(adminRow?.credits_unlimited_after).toBe(0)
    expect(adminRow?.path).toBe("/v1/messages")
    expect(row?.account_id).toBe("acct-1")
    expect(row?.stream).toBe(0)
    expect(row?.is_subagent).toBe(1)
    expect(row?.premium_unlimited_before).toBe(0)
    expect(row?.affinity_key_used).toBe("session-key-1")
    expect(row?.affinity_key_source).toBe("x_session_id")
    expect(row?.selection_reason).toBe("affinity_miss")
    expect(row?.upstream_error_message_raw).toBe("test error body")
    expect(store.meta().userVersion).toBeGreaterThanOrEqual(11)
  })

  test("initAdminDb adds outbound header columns and store persists them", () => {
    const db = new Database(":memory:")
    initAdminDb(db)

    const columns = db
      .query("PRAGMA table_info(request_log);")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(columns).toContain("outbound_x_request_id")
    expect(columns).toContain("outbound_x_agent_task_id")
    expect(columns).toContain("outbound_x_interaction_id")
    expect(columns).toContain("outbound_x_interaction_type")
    expect(columns).toContain("outbound_openai_intent")
    expect(columns).toContain("outbound_user_agent")

    const store = new RequestHistoryStore(db)

    store.insert({
      requestId: "r-outbound",
      startedAtMs: 2000,
      method: "POST",
      path: "/v1/messages",
      stream: false,
      httpStatus: 200,
      outboundXRequestId: "upstream-req-1",
      outboundXAgentTaskId: "agent-task-1",
      outboundXInteractionId: "interaction-1",
      outboundXInteractionType: "messages-proxy",
      outboundOpenaiIntent: "messages-proxy",
      outboundUserAgent: "vscode_claude_code/2.1.81",
    })

    const row = store.getByRequestId("r-outbound") as
      | (Record<string, unknown> & { request_id?: string })
      | null

    expect(row?.request_id).toBe("r-outbound")
    expect(row?.outbound_x_request_id).toBe("upstream-req-1")
    expect(row?.outbound_x_agent_task_id).toBe("agent-task-1")
    expect(row?.outbound_x_interaction_id).toBe("interaction-1")
    expect(row?.outbound_x_interaction_type).toBe("messages-proxy")
    expect(row?.outbound_openai_intent).toBe("messages-proxy")
    expect(row?.outbound_user_agent).toBe("vscode_claude_code/2.1.81")
    expect(store.meta().userVersion).toBeGreaterThanOrEqual(13)
  })

  test("store.insert consumes outbound snapshot after the first write", () => {
    const db = new Database(":memory:")
    initAdminDb(db)

    const store = new RequestHistoryStore(db)

    requestContext.run(
      {
        traceId: "trace-1",
        startTime: 1,
        userAgent: "Claude-Code-Test",
        sessionAffinity: undefined,
        parentSessionId: undefined,
      },
      () => {
        captureOutboundHeadersSnapshot({
          "x-request-id": "upstream-req-2",
          "x-agent-task-id": "agent-task-2",
          "x-interaction-id": "interaction-2",
          "x-interaction-type": "messages-proxy",
          "openai-intent": "messages-proxy",
          "user-agent": "vscode_claude_code/2.1.81",
        })

        store.insert({
          requestId: "r-snapshot-1",
          startedAtMs: 3000,
          method: "POST",
          path: "/v1/messages",
          stream: false,
          httpStatus: 200,
        })

        store.insert({
          requestId: "r-snapshot-2",
          startedAtMs: 4000,
          method: "POST",
          path: "/v1/messages",
          stream: false,
          httpStatus: 200,
        })
      },
    )

    const firstRow = store.getByRequestId("r-snapshot-1") as
      | (Record<string, unknown> & { request_id?: string })
      | null
    const secondRow = store.getByRequestId("r-snapshot-2") as
      | (Record<string, unknown> & { request_id?: string })
      | null

    expect(firstRow?.outbound_x_request_id).toBe("upstream-req-2")
    expect(firstRow?.outbound_x_interaction_id).toBe("interaction-2")
    expect(firstRow?.outbound_user_agent).toBe("vscode_claude_code/2.1.81")
    expect(secondRow?.outbound_x_request_id).toBeNull()
    expect(secondRow?.outbound_x_interaction_id).toBeNull()
    expect(secondRow?.outbound_x_agent_task_id).toBeNull()
    expect(secondRow?.outbound_x_interaction_type).toBeNull()
    expect(secondRow?.outbound_openai_intent).toBeNull()
    expect(secondRow?.outbound_user_agent).toBeNull()
  })
})

describe("RequestHistoryStore migrations", () => {
  test("initAdminDb replays v11 patch when user_version is 11 but columns are missing", () => {
    const db = new Database(":memory:")
    db.run(`
      CREATE TABLE request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE
      );
    `)
    db.run("PRAGMA user_version = 11;")

    initAdminDb(db)

    const columns = db
      .query("PRAGMA table_info(request_log);")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(columns).toContain("outbound_x_request_id")
    expect(columns).toContain("outbound_x_agent_task_id")
    expect(columns).toContain("outbound_x_interaction_id")
    expect(columns).toContain("outbound_x_interaction_type")
    expect(columns).toContain("outbound_openai_intent")
    expect(columns).toContain("outbound_user_agent")
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'request_outbound' LIMIT 1;",
        )
        .get(),
    ).toEqual({ name: "request_outbound" })
    expect(db.query("PRAGMA user_version;").get()).toEqual({ user_version: 13 })
  })

  test("initAdminDb is idempotent when is_subagent already exists but user_version is stale", () => {
    const db = new Database(":memory:")
    initAdminDb(db)
    db.run("PRAGMA user_version = 5;")

    expect(() => initAdminDb(db)).not.toThrow()
    expect(
      db
        .query("PRAGMA table_info(request_log);")
        .all()
        .some((row) => (row as { name?: string }).name === "is_subagent"),
    ).toBe(true)

    const columns = db
      .query("PRAGMA table_info(request_log);")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toContain("affinity_key_used")
    expect(columns).toContain("affinity_key_source")
    expect(columns).toContain("selection_reason")
    expect(columns).toContain("upstream_error_message_raw")
    expect(columns).toContain("outbound_x_request_id")
    expect(columns).toContain("outbound_x_agent_task_id")
    expect(columns).toContain("outbound_x_interaction_id")
    expect(columns).toContain("outbound_x_interaction_type")
    expect(columns).toContain("outbound_openai_intent")
    expect(columns).toContain("outbound_user_agent")

    expect(db.query("PRAGMA user_version;").get()).toEqual({ user_version: 13 })
  })

  test("initAdminDb upgrades v10 to v11 without replaying quota backfill", () => {
    const db = new Database(":memory:")
    initAdminDb(db)

    db.run(
      `INSERT INTO request_log (
        request_id,
        started_at_ms,
        finished_at_ms,
        method,
        path,
        stream,
        account_id,
        premium_remaining_after,
        premium_unlimited_after,
        http_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "r-v10-upgrade",
        1000,
        2000,
        "POST",
        "/v1/messages",
        0,
        "acct-upgrade",
        42,
        0,
        200,
      ],
    )

    db.run(
      `INSERT INTO quota_snapshots (
        account_id,
        snapshot_at_ms,
        remaining,
        entitlement,
        unlimited,
        source
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      ["acct-upgrade", 2000, 42, 0, 0, "backfill"],
    )

    db.run("PRAGMA user_version = 10;")

    initAdminDb(db)

    const row = db
      .query(
        `SELECT COUNT(*) AS count
         FROM quota_snapshots
         WHERE account_id = 'acct-upgrade'
           AND snapshot_at_ms = 2000`,
      )
      .get() as { count: number }

    expect(row.count).toBe(1)
    expect(db.query("PRAGMA user_version;").get()).toEqual({ user_version: 13 })
  })
})

describe("RequestHistoryStore queries and stats", () => {
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
