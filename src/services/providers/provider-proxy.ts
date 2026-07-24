import {
  fetch as undiciFetch,
  getGlobalDispatcher,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from "undici"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

const SHARED_FORWARDABLE_HEADERS = ["accept", "user-agent"] as const

const ANTHROPIC_FORWARDABLE_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
] as const

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const

export function buildProviderUpstreamHeaders(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Record<string, string> {
  const authHeaders: Record<string, string> = {}
  if (providerConfig.authType === "x-api-key") {
    authHeaders["x-api-key"] = providerConfig.apiKey
  } else {
    authHeaders.authorization = `Bearer ${providerConfig.apiKey}`
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...authHeaders,
  }

  for (const headerName of SHARED_FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  if (providerConfig.type !== "anthropic") {
    return headers
  }

  for (const headerName of ANTHROPIC_FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  return headers
}

export function createProviderProxyResponse(
  upstreamResponse: Response,
  body?: ReadableStream<Uint8Array> | null,
): Response {
  const headers = new Headers(upstreamResponse.headers)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return new Response(body ?? upstreamResponse.body, {
    headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

export async function forwardProviderMessages(
  providerConfig: ResolvedProviderConfig,
  payload: AnthropicMessagesPayload,
  requestHeaders: Headers,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return await fetchImpl(`${providerConfig.baseUrl}/v1/messages`, {
    method: "POST",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
    body: JSON.stringify(payload),
  })
}

export async function forwardProviderChatCompletions(
  providerConfig: ResolvedProviderConfig,
  payload: ChatCompletionsPayload,
  requestHeaders: Headers,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return await fetchImpl(`${providerConfig.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
    body: JSON.stringify(payload),
  })
}

export async function forwardProviderResponses(
  providerConfig: ResolvedProviderConfig,
  payload: ResponsesPayload,
  requestHeaders: Headers,
): Promise<Response> {
  return await fetch(`${providerConfig.baseUrl}/v1/responses`, {
    method: "POST",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
    body: JSON.stringify(payload),
  })
}

export async function forwardProviderModels(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return await fetchImpl(`${providerConfig.baseUrl}/v1/models`, {
    method: "GET",
    headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
  })
}

/** Align with Codex images: long-running generation/edits need a generous cap. */
const PROVIDER_IMAGES_TIMEOUT_MS = 15 * 60 * 1000

const providerImagesDispatcher = {
  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ) {
    return getGlobalDispatcher().dispatch(
      {
        ...options,
        bodyTimeout: PROVIDER_IMAGES_TIMEOUT_MS,
        headersTimeout: PROVIDER_IMAGES_TIMEOUT_MS,
      },
      handler,
    )
  },
} as Dispatcher

function resolveProviderRequestUrl(
  providerConfig: ResolvedProviderConfig,
  requestUrl: string,
  path: string,
): string {
  const upstreamUrl = new URL(`${providerConfig.baseUrl}${path}`)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardProviderAlphaSearch(
  providerConfig: ResolvedProviderConfig,
  request: Request,
): Promise<Response> {
  const headers = buildProviderUpstreamHeaders(providerConfig, request.headers)
  const body = await request.arrayBuffer()

  return await fetch(
    resolveProviderRequestUrl(providerConfig, request.url, "/v1/alpha/search"),
    {
      method: "POST",
      headers,
      body,
    },
  )
}

export async function forwardProviderImages(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  operation: "generations" | "edits",
): Promise<Response> {
  const headers = buildProviderUpstreamHeaders(providerConfig, request.headers)
  const contentType = request.headers.get("content-type")
  if (contentType) {
    headers["content-type"] = contentType
  } else if (operation === "edits") {
    delete headers["content-type"]
  }

  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
    signal: AbortSignal.timeout(PROVIDER_IMAGES_TIMEOUT_MS),
  }

  const upstreamUrl = resolveProviderRequestUrl(
    providerConfig,
    request.url,
    `/v1/images/${operation}`,
  )

  if (typeof Bun !== "undefined") {
    return await fetch(upstreamUrl, init)
  }

  // Node's global fetch keeps Undici's shorter default headers/body timeouts.
  // Use an explicit dispatcher so the documented 15-minute cap applies there.
  return (await undiciFetch(upstreamUrl, {
    ...init,
    dispatcher: providerImagesDispatcher,
  } as unknown as UndiciRequestInit)) as unknown as Response
}
