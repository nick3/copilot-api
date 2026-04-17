import { Hono, type Context } from "hono"

import type { AppConfig, DevModeConfig } from "~/lib/config"

import { getConfig, mergeConfigWithDefaults } from "~/lib/config"
import { isDevModeEnabled } from "~/lib/dev-mode"
import { getRequestHistoryStore } from "~/lib/request-history"
import {
  getRedactedHeaderKeys,
  getRequestOutboundStore,
} from "~/lib/request-outbound"

import { writeConfigFile } from "./config-writer"

export const replayRoutes = new Hono()

replayRoutes.get("/dev-mode", (c) => {
  const dev = getConfig().devMode ?? { enabled: false, capture4xx: false }
  return c.json({
    enabled: dev.enabled,
    capture4xx: dev.capture4xx,
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
  const current = getConfig().devMode ?? { enabled: false, capture4xx: false }
  const next: DevModeConfig = {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    capture4xx:
      typeof patch.capture4xx === "boolean" ?
        patch.capture4xx
      : current.capture4xx,
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
