import { afterEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"

import "./shared-admin-db-test-home"

import type { OutboundCaptureRow } from "~/lib/request-outbound"
import type { AccountContext } from "~/lib/types/account"

import { getAdminDb } from "~/lib/admin-db"
import { mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { getRequestHistoryStore } from "~/lib/request-history"

type TestConfig = Record<string, unknown>

let outboundRow: OutboundCaptureRow | null = null
let mockAccount: AccountContext | null = null
let lastFetchInit: RequestInit | null = null
let mockFetchResponse: Response = new Response('{"ok":true}', {
  status: 200,
  headers: { "content-type": "application/json" },
})

const realOutbound = await import("~/lib/request-outbound")
await mock.module("~/lib/request-outbound", () => ({
  ...realOutbound,
  getRequestOutboundStore: () => ({
    insert: () => {},
    getByRequestId: () => outboundRow,
    cleanupOrphans: () => {},
    meta: () => ({ dbPath: "", userVersion: 0 }),
  }),
  getRedactedHeaderKeys: (headers: Record<string, string>) =>
    Object.keys(headers).filter((k) => k.toLowerCase() === "authorization"),
}))

const realAccountsManager = await import("~/lib/accounts-manager")
await mock.module("~/lib/accounts-manager", () => ({
  ...realAccountsManager,
  accountsManager: new Proxy(realAccountsManager.accountsManager, {
    get(target, prop) {
      if (prop === "getAccountContextById") {
        return (_id: string) => mockAccount
      }
      return Reflect.get(target, prop) as unknown
    },
  }),
}))

const realCopilotFetch = await import("~/services/copilot/copilot-fetch")
await mock.module("~/services/copilot/copilot-fetch", () => ({
  ...realCopilotFetch,
  copilotFetch: (_url: string | URL, init: RequestInit) => {
    lastFetchInit = init
    return Promise.resolve(mockFetchResponse)
  },
}))

const { replayRoutes } = await import("../src/routes/admin-api/replay")

const withConfig = async (config: TestConfig, run: () => Promise<void>) => {
  const original = await fs
    .readFile(PATHS.CONFIG_PATH, "utf8")
    .catch(() => null)
  await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
  await fs.writeFile(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()
  try {
    await run()
  } finally {
    const restoreConfig =
      original === null ?
        fs.rm(PATHS.CONFIG_PATH, { force: true })
      : fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    await restoreConfig
    mergeConfigWithDefaults()
  }
}

function createApp() {
  const app = new Hono()
  app.route("/", replayRoutes)
  return app
}

const VALID_BLOB: OutboundCaptureRow = {
  requestId: "req-replay",
  capturedAtMs: 100000,
  httpStatus: 400,
  upstreamUrl: "https://api.githubcopilot.com/chat/completions",
  upstreamMethod: "POST",
  requestHeaders: {
    Authorization: "***",
    "content-type": "application/json",
    "x-request-id": "abc-123",
  },
  requestBody: '{"model":"claude-sonnet-4.5","messages":[]}',
  requestBodyKind: "json",
  responseStatus: 400,
  responseHeaders: { "content-type": "application/json" },
  responseBody: '{"error":"bad"}',
  responseBodyKind: "json",
}

const VALID_ACCOUNT: AccountContext = {
  accountLogin: "test-user",
  githubToken: "gh-token",
  copilotToken: "copilot-token-fresh",
  accountType: "individual",
  vsCodeVersion: "1.90.0",
}

function insertRequestLog(requestId: string) {
  getRequestHistoryStore().insert({
    requestId,
    startedAtMs: 1,
    method: "POST",
    path: "/v1/messages",
    upstreamEndpoint: "/chat/completions",
    stream: false,
    accountId: "acc-1",
    clientModel: "claude-3-7-sonnet",
    upstreamModel: "claude-sonnet-4.5",
    httpStatus: 400,
  })
}

afterEach(() => {
  outboundRow = null
  mockAccount = null
  lastFetchInit = null
  mockFetchResponse = new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  try {
    getAdminDb().run("DELETE FROM request_log;")
  } catch {
    // ignore
  }
})

// PLACEHOLDER_FOR_TESTS

test("POST replay returns 403 when dev mode is disabled", async () => {
  await withConfig({}, async () => {
    const app = createApp()
    const response = await app.request(
      "http://localhost/requests/req-1/replay",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "acc-1" }),
      },
    )
    expect(response.status).toBe(403)
    const json = (await response.json()) as { error: { type: string } }
    expect(json.error.type).toBe("forbidden")
  })
})

test("POST replay returns 404 when blob is missing", async () => {
  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      outboundRow = null
      const app = createApp()
      const response = await app.request(
        "http://localhost/requests/req-missing/replay",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: "acc-1" }),
        },
      )
      expect(response.status).toBe(404)
      const json = (await response.json()) as { error: { type: string } }
      expect(json.error.type).toBe("not_found")
    },
  )
})

test("POST replay returns 404 when request_log is missing", async () => {
  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      outboundRow = { ...VALID_BLOB }
      // Don't insert request_log
      const app = createApp()
      const response = await app.request(
        "http://localhost/requests/req-replay/replay",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: "acc-1" }),
        },
      )
      expect(response.status).toBe(404)
    },
  )
})

test("POST replay returns 400 when account is invalid", async () => {
  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      outboundRow = { ...VALID_BLOB }
      insertRequestLog("req-replay")
      mockAccount = null
      const app = createApp()
      const response = await app.request(
        "http://localhost/requests/req-replay/replay",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: "bad-acc" }),
        },
      )
      expect(response.status).toBe(400)
      const json = (await response.json()) as { error: { type: string } }
      expect(json.error.type).toBe("bad_request")
    },
  )
})

test("POST replay returns 400 when body override is invalid JSON for json kind", async () => {
  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      outboundRow = { ...VALID_BLOB }
      insertRequestLog("req-replay")
      mockAccount = { ...VALID_ACCOUNT }
      const app = createApp()
      const response = await app.request(
        "http://localhost/requests/req-replay/replay",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: "acc-1", body: "not{json" }),
        },
      )
      expect(response.status).toBe(400)
      const json = (await response.json()) as {
        error: { message: string; type: string }
      }
      expect(json.error.type).toBe("bad_request")
      expect(json.error.message).toContain("not valid JSON")
    },
  )
})

test("POST replay collect mode returns upstream response with raw body and durationMs", async () => {
  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      outboundRow = { ...VALID_BLOB }
      insertRequestLog("req-replay")
      mockAccount = { ...VALID_ACCOUNT }
      mockFetchResponse = new Response(
        '{"error":"bad request from upstream"}',
        {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        },
      )
      const app = createApp()
      const response = await app.request(
        "http://localhost/requests/req-replay/replay",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: "acc-1", mode: "collect" }),
        },
      )
      expect(response.status).toBe(200)
      const json = (await response.json()) as {
        status: number
        raw: { body: string; kind: string }
        durationMs: number
        replayedAt: number
      }
      expect(json.status).toBe(400)
      expect(json.raw.body).toBe('{"error":"bad request from upstream"}')
      expect(json.raw.kind).toBe("json")
      expect(typeof json.durationMs).toBe("number")
      expect(typeof json.replayedAt).toBe("number")
    },
  )
})

test("POST replay outgoing headers do NOT contain *** values", async () => {
  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      outboundRow = {
        ...VALID_BLOB,
        requestHeaders: {
          Authorization: "***",
          "x-github-token": "***",
          "content-type": "application/json",
          "x-custom": "keep-me",
        },
      }
      insertRequestLog("req-replay")
      mockAccount = { ...VALID_ACCOUNT }
      const app = createApp()
      await app.request("http://localhost/requests/req-replay/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "acc-1" }),
      })
      expect(lastFetchInit).not.toBeNull()
      const sentHeaders = (lastFetchInit ?? {}).headers as Record<
        string,
        string
      >
      const starValues = Object.entries(sentHeaders).filter(
        ([, v]) => v === "***",
      )
      expect(starValues).toHaveLength(0)
      // Auth header should be injected fresh
      expect(
        sentHeaders["Authorization"] ?? sentHeaders["authorization"],
      ).toBeTruthy()
      // Custom header should be preserved
      expect(sentHeaders["x-custom"]).toBe("keep-me")
    },
  )
})
