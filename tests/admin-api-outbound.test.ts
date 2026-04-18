import { afterEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"

import "./shared-admin-db-test-home"

import type { OutboundCaptureRow } from "~/lib/request-outbound"

import { getAdminDb } from "~/lib/admin-db"
import { mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { getRequestHistoryStore } from "~/lib/request-history"

type TestConfig = Record<string, unknown>

let outboundRow: OutboundCaptureRow | null = null

const realOutbound = await import("~/lib/request-outbound")

await mock.module("~/lib/request-outbound", () => ({
  ...realOutbound,
  getRequestOutboundStore: () => ({
    insert: () => {},
    getByRequestId: () => outboundRow,
    hasOutboundForIds: () => new Set(),
    cleanupOrphans: () => {},
    meta: () => ({ dbPath: "", userVersion: 0 }),
  }),
  getRedactedHeaderKeys: (headers: Record<string, string>) =>
    Object.keys(headers).filter((key) => key.toLowerCase() === "authorization"),
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

afterEach(() => {
  outboundRow = null
  getAdminDb().run("DELETE FROM request_log;")
})

test("GET /requests/:id/outbound returns 403 when dev mode is disabled", async () => {
  await withConfig({}, async () => {
    const app = createApp()

    const response = await app.request(
      "http://localhost/requests/req-disabled/outbound",
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        message: "Developer mode disabled",
        type: "forbidden",
      },
    })
  })
})

test("GET /requests/:id/outbound returns 404 when no outbound capture exists", async () => {
  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      const app = createApp()

      const response = await app.request(
        "http://localhost/requests/req-missing/outbound",
      )

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: {
          message: "No outbound captured for this request",
          type: "not_found",
        },
      })
    },
  )
})

test("GET /requests/:id/outbound returns blob data, redacted headers, and original request context", async () => {
  outboundRow = {
    requestId: "req-blob",
    capturedAtMs: 123456789,
    httpStatus: 400,
    upstreamUrl: "https://api.githubcopilot.com/v1/messages",
    upstreamMethod: "POST",
    requestHeaders: {
      Authorization: "***",
      "content-type": "application/json",
      "x-request-id": "abc-123",
    },
    requestBody: '{"model":"claude-sonnet-4.5"}',
    requestBodyKind: "json",
    responseStatus: 400,
    responseHeaders: {
      "content-type": "application/json",
    },
    responseBody: '{"error":"bad request"}',
    responseBodyKind: "json",
  }

  // Insert a real request_log row so getRequestHistoryStore().getByRequestId works
  getRequestHistoryStore().insert({
    requestId: "req-blob",
    startedAtMs: 1,
    method: "POST",
    path: "/v1/messages",
    upstreamEndpoint: "/v1/messages",
    stream: false,
    accountId: "acc-1",
    clientModel: "claude-3-7-sonnet",
    upstreamModel: "claude-sonnet-4.5",
    httpStatus: 400,
  })

  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      const app = createApp()

      const response = await app.request(
        "http://localhost/requests/req-blob/outbound",
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        request_id: "req-blob",
        captured_at_ms: 123456789,
        http_status: 400,
        upstream_url: "https://api.githubcopilot.com/v1/messages",
        upstream_method: "POST",
        request_headers: {
          Authorization: "***",
          "content-type": "application/json",
          "x-request-id": "abc-123",
        },
        request_body: '{"model":"claude-sonnet-4.5"}',
        request_body_kind: "json",
        response_status: 400,
        response_headers: {
          "content-type": "application/json",
        },
        response_body: '{"error":"bad request"}',
        response_body_kind: "json",
        redacted_header_keys: ["Authorization"],
        original: {
          path: "/v1/messages",
          upstream_endpoint: "/v1/messages",
          upstream_model: "claude-sonnet-4.5",
          account_id: "acc-1",
          client_model: "claude-3-7-sonnet",
        },
      })
    },
  )
})
