import { afterEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"

import type { RequestLogRow } from "~/lib/request-history"
import type { OutboundCaptureRow } from "~/lib/request-outbound"

import { mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"

type TestConfig = Record<string, unknown>

let outboundRow: OutboundCaptureRow | null = null
let historyRow: RequestLogRow | null = null

await mock.module("~/lib/request-outbound", () => ({
  getRequestOutboundStore: () => ({
    getByRequestId: () => outboundRow,
  }),
  getRedactedHeaderKeys: (headers: Record<string, string>) =>
    Object.keys(headers).filter((key) => key.toLowerCase() === "authorization"),
}))

await mock.module("~/lib/request-history", () => ({
  getRequestHistoryStore: () => ({
    getByRequestId: () => historyRow,
  }),
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
  historyRow = null
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

  historyRow = {
    id: 1,
    request_id: "req-blob",
    started_at_ms: 1,
    finished_at_ms: null,
    method: "POST",
    path: "/v1/messages",
    upstream_endpoint: "/v1/messages",
    stream: 0,
    account_id: "acc-1",
    account_type: null,
    cost_units: 0,
    client_model: "claude-3-7-sonnet",
    upstream_model: "claude-sonnet-4.5",
    client_ip: null,
    client_ip_source: null,
    user_agent: null,
    user_id: null,
    safety_identifier: null,
    prompt_cache_key: null,
    initiator: null,
    is_subagent: null,
    upstream_request_id: null,
    outbound_x_request_id: null,
    outbound_x_agent_task_id: null,
    outbound_x_interaction_type: null,
    outbound_openai_intent: null,
    outbound_user_agent: null,
    affinity_key_used: null,
    affinity_key_source: null,
    selection_reason: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    tokens_cached_input: null,
    usage_json: null,
    premium_remaining_before: null,
    premium_remaining_after: null,
    premium_remaining_diff: null,
    premium_unlimited_before: null,
    premium_unlimited_after: null,
    status: "error",
    http_status: 400,
    duration_ms: null,
    ttfb_ms: null,
    model: null,
    provider: null,
    service_tier: null,
    endpoint: null,
    error_name: null,
    error_status: null,
    error_message: null,
    upstream_error_message_raw: null,
    selection_failure_reason: null,
    affinity_hit: null,
    affinity_cache_key: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    account_label: null,
  } as RequestLogRow

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
