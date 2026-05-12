import type { ResolvedProviderConfig } from "~/lib/config"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

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
  if (providerConfig.authType === "authorization") {
    authHeaders.authorization = `Bearer ${providerConfig.apiKey}`
  } else {
    authHeaders["x-api-key"] = providerConfig.apiKey
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
): Response {
  const headers = new Headers(upstreamResponse.headers)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return new Response(upstreamResponse.body, {
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
