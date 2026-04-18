import consola from "consola"

import {
  isCapture4xxEnabled,
  isCapture5xxEnabled,
  isCaptureOtherEnabled,
} from "~/lib/dev-mode"
import { getRequestOutboundStore } from "~/lib/request-outbound"

export type CopilotFetchCtx = {
  requestId?: string
  capturable?: boolean
  callSite: string
}

type RequestSnapshot = {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  bodyKind: "json" | "text" | "binary"
}

function snapshotHeaders(init: RequestInit): Record<string, string> {
  const headers = init.headers
  if (headers instanceof Headers) {
    const out: Record<string, string> = {}
    for (const [key, value] of headers.entries()) {
      out[key] = value
    }
    return out
  }

  if (Array.isArray(headers)) {
    const out: Record<string, string> = {}
    for (const [key, value] of headers) {
      out[key] = value
    }
    return out
  }

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(
    (headers ?? {}) as Record<string, string>,
  )) {
    out[key] = value
  }
  return out
}

function snapshotBody(init: RequestInit): {
  body: string | null
  bodyKind: "json" | "text" | "binary"
} {
  const body = init.body
  if (body === null || body === undefined) {
    return { body: null, bodyKind: "text" }
  }

  if (typeof body === "string") {
    try {
      JSON.parse(body)
      return { body, bodyKind: "json" }
    } catch {
      return { body, bodyKind: "text" }
    }
  }

  if (body instanceof Uint8Array) {
    return { body: Buffer.from(body).toString("base64"), bodyKind: "binary" }
  }

  if (body instanceof ArrayBuffer) {
    return {
      body: Buffer.from(new Uint8Array(body)).toString("base64"),
      bodyKind: "binary",
    }
  }

  return { body: null, bodyKind: "text" }
}

function shouldCaptureStatus(status: number): boolean {
  if (status >= 400 && status < 500) return isCapture4xxEnabled()
  if (status >= 500) return isCapture5xxEnabled()
  return isCaptureOtherEnabled()
}

export async function copilotFetch(
  input: string | URL,
  init: RequestInit,
  ctx: CopilotFetchCtx,
): Promise<Response> {
  const urlString = typeof input === "string" ? input : input.toString()

  const requestSnapshot: RequestSnapshot = {
    url: urlString,
    method: (init.method ?? "GET").toUpperCase(),
    headers: snapshotHeaders(init),
    ...snapshotBody(init),
  }

  const response = await fetch(input, init)

  const shouldCapture =
    ctx.requestId !== undefined
    && ctx.capturable !== false
    && shouldCaptureStatus(response.status)

  if (!shouldCapture) {
    return response
  }

  const contentType = response.headers.get("content-type") ?? ""
  const isSSE = contentType.includes("text/event-stream")
  const responseHeaders: Record<string, string> = {}
  for (const [key, value] of response.headers.entries()) {
    responseHeaders[key] = value
  }

  if (!response.body) {
    persist({
      requestSnapshot,
      status: response.status,
      responseBody: "",
      responseBodyKind: isSSE ? "sse" : "json",
      responseHeaders,
      ctx,
    })
    return response
  }

  const [forClient, forCapture] = response.body.tee()

  void (async () => {
    const chunks: Array<Uint8Array> = []
    const reader =
      forCapture.getReader() as ReadableStreamDefaultReader<Uint8Array>

    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) {
          break
        }

        const value = result.value
        if (value instanceof Uint8Array) {
          chunks.push(value)
        }
      }

      const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      const text = buffer.toString("utf8")
      let responseBodyKind: "json" | "sse" | "text" = "text"

      if (isSSE) {
        responseBodyKind = "sse"
      } else if (contentType.includes("application/json")) {
        responseBodyKind = "json"
      }

      persist({
        requestSnapshot,
        status: response.status,
        responseBody: text,
        responseBodyKind,
        responseHeaders,
        ctx,
      })
    } catch (error) {
      consola.debug("copilotFetch capture stream failed", error)
    }
  })()

  return new Response(forClient, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

type PersistInput = {
  requestSnapshot: RequestSnapshot
  status: number
  responseBody: string
  responseBodyKind: "json" | "sse" | "text"
  responseHeaders: Record<string, string>
  ctx: CopilotFetchCtx
}

function persist({
  requestSnapshot,
  status,
  responseBody,
  responseBodyKind,
  responseHeaders,
  ctx,
}: PersistInput): void {
  if (!ctx.requestId) {
    return
  }

  try {
    getRequestOutboundStore().insert({
      requestId: ctx.requestId,
      httpStatus: status,
      upstreamUrl: requestSnapshot.url,
      upstreamMethod: requestSnapshot.method,
      requestHeaders: requestSnapshot.headers,
      requestBody: requestSnapshot.body,
      requestBodyKind: requestSnapshot.bodyKind,
      responseStatus: status,
      responseHeaders,
      responseBody,
      responseBodyKind,
    })
  } catch (error) {
    consola.debug("copilotFetch persist failed", error)
  }
}
