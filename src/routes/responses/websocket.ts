import consola from "consola"
import { randomUUID } from "node:crypto"

import {
  createUnauthorizedRawResponse,
  isAuthorizedHeaders,
} from "~/lib/request-auth"
import {
  registerResponsesBridge,
  unregisterResponsesBridge,
} from "~/services/copilot/responses-bridge-registry"

const RESPONSES_BRIDGE_ID_HEADER = "x-responses-bridge-id"

const RESPONSES_WEBSOCKET_PATHS = new Set(["/responses", "/v1/responses"])
const SSE_RECORD_SEPARATOR = /\r?\n\r?\n/u
const FORWARDED_HEADER_NAMES = [
  "authorization",
  "x-api-key",
  "user-agent",
  "x-session-id",
  "x-session-affinity",
  "x-parent-session-id",
  "x-trace-id",
]

type ServerWebSocket = Bun.ServerWebSocket<ResponsesWebSocketData>
type AppFetch = (request: Request) => Response | Promise<Response>

export type ResponsesWebSocketData = {
  // Codex keeps a single persistent websocket per session and pipelines turns
  // over it: a turn's `response.create` can arrive before the previous turn's
  // SSE relay has finished tearing down. Bun does not serialize async `message`
  // callbacks, so we chain work on this promise to process frames strictly in
  // arrival order instead of rejecting concurrent frames.
  queue: Promise<void>
  // In-flight upstream requests, one AbortController per active `response.create`
  // frame, so a client disconnect can abort all of them.
  controllers: Set<AbortController>
  headers: Array<[string, string]>
  url: string
  // Stable id minted per bridge connection. It is forwarded to the upstream
  // Responses pool (via `x-responses-bridge-id`) so the pool can close this exact
  // socket when its upstream connection is reaped, forcing Codex to rebuild a
  // fresh full-context session instead of stalling on a stale
  // `previous_response_id`.
  bridgeId: string
}

type ResponsesWebSocketFrame = {
  type?: unknown
  [key: string]: unknown
}

export function createResponsesWebSocketHandler(
  appFetch: AppFetch,
): Bun.WebSocketHandler<ResponsesWebSocketData> {
  return {
    data: {} as ResponsesWebSocketData,
    idleTimeout: 0,
    open(ws) {
      // Register a closer so the upstream pool can drop this socket when its
      // GitHub connection is reaped while idle.
      registerResponsesBridge(ws.data.bridgeId, () => {
        try {
          ws.close()
        } catch (error) {
          consola.warn("Failed to close Responses websocket bridge:", error)
        }
      })
    },
    async message(ws, message) {
      await handleResponsesWebSocketMessage(ws, message, appFetch)
    },
    close(ws) {
      unregisterResponsesBridge(ws.data.bridgeId)
      // Abort every in-flight upstream Responses request so we stop consuming
      // tokens/quota and worker time once the client disconnects.
      for (const controller of ws.data.controllers) {
        controller.abort()
      }
      ws.data.controllers.clear()
    },
  }
}

export function handleResponsesWebSocketUpgrade(
  req: Request,
  server: Bun.Server<ResponsesWebSocketData>,
): Response | null | undefined {
  if (!isResponsesWebSocketUpgrade(req)) {
    return null
  }

  if (!isAuthorizedHeaders(req.headers)) {
    return createUnauthorizedRawResponse()
  }

  const upgraded = server.upgrade(req, {
    data: buildResponsesWebSocketData(req),
  })

  if (upgraded) {
    return undefined
  }

  return new Response("WebSocket upgrade failed", { status: 400 })
}

export function isResponsesWebSocketUpgrade(req: Request): boolean {
  if (req.method !== "GET") {
    return false
  }

  const pathname = new URL(req.url).pathname
  if (!RESPONSES_WEBSOCKET_PATHS.has(pathname)) {
    return false
  }

  return req.headers.get("upgrade")?.toLowerCase() === "websocket"
}

export async function handleResponsesWebSocketMessage(
  ws: ServerWebSocket,
  message: string | ArrayBuffer | Uint8Array,
  appFetch: AppFetch,
): Promise<void> {
  let frame: ResponsesWebSocketFrame
  try {
    frame = JSON.parse(
      normalizeWebSocketMessage(message),
    ) as ResponsesWebSocketFrame
  } catch {
    sendResponsesWebSocketError(ws, "Invalid websocket JSON frame", 400)
    return
  }

  if (frame.type === "response.processed") {
    return
  }

  if (frame.type !== "response.create") {
    sendResponsesWebSocketError(ws, "Unsupported websocket frame type", 400)
    return
  }

  // Chain this frame after any in-flight work so pipelined turns are processed
  // strictly in arrival order. The assignment is synchronous, so even though Bun
  // may dispatch overlapping `message` callbacks, the ordering reflects the order
  // frames were received. We swallow any rejection from the prior link before
  // chaining so a single failed turn (e.g. `ws.send` throwing while the socket is
  // closing) can never poison `ws.data.queue` and block every subsequent turn for
  // the lifetime of the connection.
  const queued = ws.data.queue
    .catch(() => {})
    .then(() => processResponseCreateFrame(ws, frame, appFetch))
  ws.data.queue = queued
  await queued.catch(() => {})
}

async function processResponseCreateFrame(
  ws: ServerWebSocket,
  frame: ResponsesWebSocketFrame,
  appFetch: AppFetch,
): Promise<void> {
  if (frame.generate === false) {
    sendResponsesWebSocketWarmupCompleted(ws)
    return
  }

  const controller = new AbortController()
  ws.data.controllers.add(controller)
  try {
    await forwardResponseCreateFrame(ws, frame, appFetch, controller)
  } catch (error) {
    // A client disconnect aborts in-flight controllers; that is expected
    // teardown, not a failure to report back to the (now gone) client.
    if (controller.signal.aborted) {
      return
    }
    consola.warn("Responses websocket bridge failed:", error)
    sendResponsesWebSocketError(
      ws,
      error instanceof Error ? error.message : String(error),
      500,
    )
  } finally {
    ws.data.controllers.delete(controller)
  }
}

export function parseSseRecords(chunk: string): {
  events: Array<string>
  remainder: string
} {
  const events: Array<string> = []
  let remainder = chunk

  while (true) {
    const match = SSE_RECORD_SEPARATOR.exec(remainder)
    if (!match) {
      break
    }

    const record = remainder.slice(0, match.index)
    remainder = remainder.slice(match.index + match[0].length)
    const data = parseSseRecordData(record)
    if (data !== null && data !== "[DONE]") {
      events.push(data)
    }
  }

  return { events, remainder }
}

function buildResponsesWebSocketData(req: Request): ResponsesWebSocketData {
  return {
    queue: Promise.resolve(),
    controllers: new Set(),
    headers: collectForwardedHeaders(req.headers),
    url: req.url,
    bridgeId: randomUUID(),
  }
}

function collectForwardedHeaders(headers: Headers): Array<[string, string]> {
  const forwarded: Array<[string, string]> = []
  for (const name of FORWARDED_HEADER_NAMES) {
    const value = headers.get(name)
    if (value) {
      forwarded.push([name, value])
    }
  }
  return forwarded
}

async function forwardResponseCreateFrame(
  ws: ServerWebSocket,
  frame: ResponsesWebSocketFrame,
  appFetch: AppFetch,
  controller: AbortController,
): Promise<void> {
  const payload = { ...frame, stream: true }
  delete payload.type

  const response = await appFetch(
    new Request(buildInternalResponsesUrl(ws.data.url), {
      method: "POST",
      headers: buildInternalResponsesHeaders(ws.data.headers, ws.data.bridgeId),
      body: JSON.stringify(payload),
      signal: controller.signal,
    }),
  )

  if (!response.ok) {
    sendResponsesWebSocketError(
      ws,
      await readErrorResponseMessage(response),
      response.status,
    )
    return
  }

  if (!response.body) {
    sendResponsesWebSocketError(ws, "Responses stream body is empty", 500)
    return
  }

  await streamSseResponseToWebSocket(ws, response.body, controller)
}

function buildInternalResponsesUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl)
  url.protocol = "http:"
  url.pathname =
    url.pathname.startsWith("/v1/") ? "/v1/responses" : "/responses"
  url.search = ""
  url.hash = ""
  return url.toString()
}

function buildInternalResponsesHeaders(
  forwardedHeaders: Array<[string, string]>,
  bridgeId: string,
): Headers {
  const headers = new Headers(forwardedHeaders)
  headers.set("content-type", "application/json")
  headers.set(RESPONSES_BRIDGE_ID_HEADER, bridgeId)
  return headers
}

async function streamSseResponseToWebSocket(
  ws: ServerWebSocket,
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  // Cancel the upstream reader as soon as the connection is aborted (client
  // close or a failed send) so the upstream stream is torn down promptly.
  const onAbort = () => {
    void reader.cancel()
  }
  controller.signal.addEventListener("abort", onAbort)

  try {
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseRecords(buffer)
      buffer = parsed.remainder
      if (!relaySseEvents(ws, parsed.events, controller)) {
        return
      }
    }

    if (controller.signal.aborted) {
      return
    }

    buffer += decoder.decode()
    const parsed = parseSseRecords(`${buffer}\n\n`)
    relaySseEvents(ws, parsed.events, controller)
  } finally {
    controller.signal.removeEventListener("abort", onAbort)
    try {
      reader.releaseLock()
    } catch {
      // Reader may already be released after cancellation; ignore.
    }
  }
}

/**
 * Relay parsed SSE events to the client. Returns `false` if a send failed and
 * the upstream request was aborted, signalling the caller to stop streaming.
 */
function relaySseEvents(
  ws: ServerWebSocket,
  events: Array<string>,
  controller: AbortController,
): boolean {
  for (const event of events) {
    if (controller.signal.aborted) {
      return false
    }
    try {
      ws.send(event)
    } catch (error) {
      consola.warn("Responses websocket send failed:", error)
      controller.abort()
      return false
    }
  }
  return true
}

function parseSseRecordData(record: string): string | null {
  const lines = record.split(/\r?\n/u)
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    // Per the SSE spec, strip only a single optional leading space after the
    // colon (not arbitrary whitespace), preserving whitespace-sensitive data.
    .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))

  if (dataLines.length === 0) {
    return null
  }

  return dataLines.join("\n")
}

function normalizeWebSocketMessage(
  message: string | ArrayBuffer | Uint8Array,
): string {
  if (typeof message === "string") {
    return message
  }

  return new TextDecoder().decode(message)
}

function sendResponsesWebSocketError(
  ws: ServerWebSocket,
  message: string,
  status: number,
): void {
  // Mirror the Responses stream error contract (see ResponseErrorEvent in
  // src/services/copilot/create-responses.ts) so clients always receive the
  // same top-level event shape regardless of where the error originates.
  ws.send(
    JSON.stringify({
      code: status ? String(status) : null,
      message,
      param: null,
      sequence_number: 0,
      type: "error",
    }),
  )
}

function sendResponsesWebSocketWarmupCompleted(ws: ServerWebSocket): void {
  ws.send(
    JSON.stringify({
      response: {
        id: "",
      },
      sequence_number: 0,
      type: "response.completed",
    }),
  )
}

async function readErrorResponseMessage(response: Response): Promise<string> {
  const body = await response.text()
  if (!body) {
    return `Responses request failed with status ${response.status}`
  }

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown }
      message?: unknown
    }
    const message =
      typeof parsed.error?.message === "string" ? parsed.error.message
      : typeof parsed.message === "string" ? parsed.message
      : undefined
    return message ?? body
  } catch {
    return body
  }
}
