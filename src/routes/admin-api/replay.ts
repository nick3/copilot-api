import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"

import type { AppConfig, DevModeConfig } from "~/lib/config"
import type { RequestLogRow } from "~/lib/request-history"
import type { OutboundCaptureRow } from "~/lib/request-outbound"
import type { AccountContext } from "~/lib/types/account"

import { accountsManager } from "~/lib/accounts-manager"
import { copilotHeaders } from "~/lib/api-config"
import { getConfig, mergeConfigWithDefaults } from "~/lib/config"
import { isDevModeEnabled } from "~/lib/dev-mode"
import { getRequestHistoryStore } from "~/lib/request-history"
import {
  getRedactedHeaderKeys,
  getRequestOutboundStore,
} from "~/lib/request-outbound"
import { copilotFetch } from "~/services/copilot/copilot-fetch"

import { writeConfigFile } from "./config-writer"
import { translateForReplay } from "./replay-translation"

export const replayRoutes = new Hono()

replayRoutes.get("/dev-mode", (c) => {
  const dev = getConfig().devMode ?? {
    enabled: false,
    capture4xx: false,
    capture5xx: false,
    captureOther: false,
  }
  return c.json({
    enabled: dev.enabled,
    capture4xx: dev.capture4xx,
    capture5xx: dev.capture5xx,
    captureOther: dev.captureOther,
  })
})

replayRoutes.post("/dev-mode", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json(
      { error: { message: "Body must be valid JSON", type: "bad_request" } },
      400,
    )
  }

  if (
    typeof payload !== "object"
    || payload === null
    || Array.isArray(payload)
  ) {
    return c.json(
      { error: { message: "Body must be an object", type: "bad_request" } },
      400,
    )
  }

  const patch = payload as Partial<DevModeConfig>
  const current = getConfig().devMode ?? {
    enabled: false,
    capture4xx: false,
    capture5xx: false,
    captureOther: false,
  }
  const next: DevModeConfig = {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    capture4xx:
      typeof patch.capture4xx === "boolean" ?
        patch.capture4xx
      : current.capture4xx,
    capture5xx:
      typeof patch.capture5xx === "boolean" ?
        patch.capture5xx
      : current.capture5xx,
    captureOther:
      typeof patch.captureOther === "boolean" ?
        patch.captureOther
      : current.captureOther,
  }

  const config: AppConfig = { ...getConfig(), devMode: next }
  await writeConfigFile(config)
  mergeConfigWithDefaults()

  return c.json(next)
})

replayRoutes.get("/requests/:requestId/outbound", (c) => {
  const gate = requireDevMode(c)
  if (gate) return gate

  const requestId = c.req.param("requestId")
  const blob = getRequestOutboundStore().getByRequestId(requestId)
  if (!blob) {
    return c.json(
      {
        error: {
          message: "No outbound captured for this request",
          type: "not_found",
        },
      },
      404,
    )
  }

  const logRow = getRequestHistoryStore().getByRequestId(requestId)

  return c.json({
    request_id: blob.requestId,
    captured_at_ms: blob.capturedAtMs,
    http_status: blob.httpStatus,
    upstream_url: blob.upstreamUrl,
    upstream_method: blob.upstreamMethod,
    request_headers: blob.requestHeaders,
    request_body: blob.requestBody,
    request_body_kind: blob.requestBodyKind,
    response_status: blob.responseStatus,
    response_headers: blob.responseHeaders,
    response_body: blob.responseBody,
    response_body_kind: blob.responseBodyKind,
    redacted_header_keys: getRedactedHeaderKeys(blob.requestHeaders),
    original:
      logRow ?
        {
          path: logRow.path,
          upstream_endpoint: logRow.upstream_endpoint,
          upstream_model: logRow.upstream_model,
          account_id: logRow.account_id,
          client_model: logRow.client_model,
        }
      : null,
  })
})

type ReplayPayload = {
  mode?: "collect" | "live"
  accountId: string
  headers?: Record<string, string>
  body?: unknown
}

type ReplayError = {
  json: { error: { message: string; type: string } }
  status: number
}

function isReplayError(
  value: string | null | ReplayError,
): value is ReplayError {
  return value !== null && typeof value === "object" && "json" in value
}

function resolveRequestBody(
  blob: OutboundCaptureRow,
  bodyOverride: unknown,
): string | null | ReplayError {
  if (bodyOverride === undefined) {
    return blob.requestBody
  }

  if (blob.requestBodyKind === "json" && typeof bodyOverride === "string") {
    try {
      JSON.parse(bodyOverride)
      return bodyOverride
    } catch {
      return {
        json: {
          error: {
            message: "body override is not valid JSON",
            type: "bad_request",
          },
        },
        status: 400,
      }
    }
  }

  if (blob.requestBodyKind === "json") {
    return JSON.stringify(bodyOverride)
  }

  return typeof bodyOverride === "string" ? bodyOverride : (
      JSON.stringify(bodyOverride)
    )
}

function buildReplayHeaders(
  blob: OutboundCaptureRow,
  headerOverrides: Record<string, string> | undefined,
  account: AccountContext,
): Record<string, string> {
  const base = { ...blob.requestHeaders }
  if (headerOverrides) {
    Object.assign(base, headerOverrides)
  }
  const cleaned = Object.fromEntries(
    Object.entries(base).filter(([, v]) => v !== "***"),
  )
  return { ...cleaned, ...copilotHeaders(account) }
}

function detectRawKind(contentType: string): "json" | "sse" | "text" {
  if (contentType.includes("text/event-stream")) return "sse"
  if (contentType.includes("application/json")) return "json"
  return "text"
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    out[key] = value
  }
  return out
}

function tryTranslate(
  upstreamEndpoint: string,
  rawText: string,
  rawKind: "json" | "sse" | "text",
): unknown {
  try {
    return translateForReplay({ upstreamEndpoint, rawText, rawKind })
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Translation failed" }
  }
}

replayRoutes.post("/requests/:requestId/replay", async (c) => {
  const gate = requireDevMode(c)
  if (gate) return gate

  const requestId = c.req.param("requestId")
  const blob = getRequestOutboundStore().getByRequestId(requestId)
  if (!blob) {
    return c.json(
      {
        error: {
          message: "No outbound captured for this request",
          type: "not_found",
        },
      },
      404,
    )
  }

  const logRow = getRequestHistoryStore().getByRequestId(requestId)
  if (!logRow) {
    return c.json(
      {
        error: {
          message: "No request log found for this request",
          type: "not_found",
        },
      },
      404,
    )
  }

  let payload: ReplayPayload
  try {
    payload = await c.req.json()
  } catch {
    return c.json(
      { error: { message: "Body must be valid JSON", type: "bad_request" } },
      400,
    )
  }

  return handleReplayRequest(c, { blob, logRow, payload })
})

async function handleReplayRequest(
  c: Context,
  input: {
    blob: OutboundCaptureRow
    logRow: RequestLogRow
    payload: ReplayPayload
  },
) {
  const { blob, logRow, payload } = input

  if (!payload.accountId || typeof payload.accountId !== "string") {
    return c.json(
      { error: { message: "accountId is required", type: "bad_request" } },
      400,
    )
  }

  const account = accountsManager.getAccountContextById(payload.accountId)
  if (!account?.copilotToken) {
    return c.json(
      {
        error: {
          message: `Account "${payload.accountId}" not found or has no valid token`,
          type: "bad_request",
        },
      },
      400,
    )
  }

  const bodyResult = resolveRequestBody(blob, payload.body)
  if (isReplayError(bodyResult)) {
    return c.json(bodyResult.json, bodyResult.status as 400)
  }

  const requestBody = bodyResult
  const mergedHeaders = buildReplayHeaders(blob, payload.headers, account)
  const mode = payload.mode ?? "collect"

  if (mode === "live") {
    const startMs = Date.now()
    let upstreamResponse: Response
    try {
      upstreamResponse = await fetchReplayUpstream({
        blob,
        headers: mergedHeaders,
        body: requestBody,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Upstream fetch failed"
      return c.json({ error: { message, type: "upstream_error" } }, 502)
    }

    return streamAndRespond(c, {
      upstreamRes: upstreamResponse,
      logRow,
      startMs,
    })
  }

  return collectAndRespond(c, {
    blob,
    upstreamEndpoint: logRow.upstream_endpoint ?? "",
    headers: mergedHeaders,
    body: requestBody,
  })
}

type ReplayUpstreamInput = {
  blob: OutboundCaptureRow
  headers: Record<string, string>
  body: string | null
}

type CollectInput = ReplayUpstreamInput & {
  upstreamEndpoint: string
}

type StreamInput = {
  upstreamRes: Response
  logRow: RequestLogRow | null
  startMs: number
}

async function fetchReplayUpstream(
  input: ReplayUpstreamInput,
): Promise<Response> {
  const { blob, headers, body } = input
  return copilotFetch(
    blob.upstreamUrl,
    { method: blob.upstreamMethod, headers, body },
    { callSite: "replay", capturable: false },
  )
}

async function collectAndRespond(c: Context, input: CollectInput) {
  const { blob, upstreamEndpoint, headers, body } = input
  const startMs = Date.now()
  let upstreamResponse: Response
  try {
    upstreamResponse = await fetchReplayUpstream({ blob, headers, body })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Upstream fetch failed"
    return c.json({ error: { message, type: "upstream_error" } }, 502)
  }
  const durationMs = Date.now() - startMs

  const responseText = await upstreamResponse.text()
  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  const rawKind = detectRawKind(contentType)

  return c.json({
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: headersToRecord(upstreamResponse.headers),
    raw: { body: responseText, kind: rawKind },
    translated: tryTranslate(upstreamEndpoint, responseText, rawKind),
    durationMs,
    replayedAt: Date.now(),
  })
}

function streamAndRespond(c: Context, input: StreamInput): Response {
  const { upstreamRes, logRow, startMs } = input

  return streamSSE(c, async (sse) => {
    const responseHeaders = headersToRecord(upstreamRes.headers)

    await sse.writeSSE({
      event: "upstream-start",
      data: JSON.stringify({
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: responseHeaders,
      }),
    })

    const rawChunks: Array<string> = []

    if (upstreamRes.body) {
      const reader = (
        upstreamRes.body as ReadableStream<Uint8Array>
      ).getReader()
      const decoder = new TextDecoder()

      for (;;) {
        const readResult = await reader.read()
        if (readResult.done) break

        const chunk = decoder.decode(readResult.value, { stream: true })
        rawChunks.push(chunk)
        await sse.writeSSE({
          event: "upstream-chunk",
          data: JSON.stringify({ raw: chunk }),
        })
      }

      const trailing = decoder.decode()
      if (trailing) {
        rawChunks.push(trailing)
        await sse.writeSSE({
          event: "upstream-chunk",
          data: JSON.stringify({ raw: trailing }),
        })
      }
    }

    await sse.writeSSE({
      event: "upstream-done",
      data: JSON.stringify({ durationMs: Date.now() - startMs }),
    })

    if (logRow?.path === "/v1/messages") {
      const contentType = upstreamRes.headers.get("content-type") ?? ""
      const rawText = rawChunks.join("")
      const rawKind = detectRawKind(contentType)

      try {
        const translated = translateForReplay({
          upstreamEndpoint: logRow.upstream_endpoint ?? "",
          rawText,
          rawKind,
        })
        await sse.writeSSE({
          event: "translated",
          data: JSON.stringify(translated),
        })
      } catch (err) {
        await sse.writeSSE({
          event: "translated",
          data: JSON.stringify({ error: (err as Error).message }),
        })
      }
    }
  })
}

export function requireDevMode(c: Context): Response | null {
  if (!isDevModeEnabled()) {
    return c.json(
      {
        error: {
          message: "Developer mode disabled",
          type: "forbidden",
        },
      },
      403,
    )
  }
  return null
}
