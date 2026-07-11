import {
  buildCodexRequestHeaders,
  CODEX_API_BASE_URL,
} from "~/services/codex/create-responses"

export function resolveCodexAlphaSearchUrl(
  requestUrl: string,
  baseUrl: string = CODEX_API_BASE_URL,
): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/u, "")
  const codexBaseUrl = normalizedBaseUrl || CODEX_API_BASE_URL
  const alphaSearchUrl = `${codexBaseUrl.replace(/\/codex(?:\/alpha\/search)?$/u, "")}/codex/alpha/search`
  const upstreamUrl = new URL(alphaSearchUrl)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardCodexAlphaSearch(
  request: Request,
  baseUrl: string = CODEX_API_BASE_URL,
): Promise<Response> {
  const headers = buildCodexRequestHeaders(request.headers)
  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  const body = await request.arrayBuffer()
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  return await fetch(resolveCodexAlphaSearchUrl(request.url, baseUrl), {
    method: "POST",
    headers,
    body,
  })
}
