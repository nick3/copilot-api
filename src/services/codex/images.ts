import {
  fetch as undiciFetch,
  getGlobalDispatcher,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from "undici"

import {
  buildCodexRequestHeaders,
  CODEX_API_BASE_URL,
} from "~/services/codex/create-responses"

export type CodexImagesOperation = "generations" | "edits"

const CODEX_IMAGES_TIMEOUT_MS = 15 * 60 * 1000

const codexImagesDispatcher = {
  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ) {
    return getGlobalDispatcher().dispatch(
      {
        ...options,
        bodyTimeout: CODEX_IMAGES_TIMEOUT_MS,
        headersTimeout: CODEX_IMAGES_TIMEOUT_MS,
      },
      handler,
    )
  },
} as Dispatcher

type StreamingRequestInit = RequestInit & {
  duplex: "half"
}

export function resolveCodexImagesUrl(
  requestUrl: string,
  operation: CodexImagesOperation,
  baseUrl: string = CODEX_API_BASE_URL,
): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/u, "")
  const codexBaseUrl = normalizedBaseUrl || CODEX_API_BASE_URL
  const imagesUrl = `${codexBaseUrl.replace(/\/codex(?:\/images(?:\/(?:generations|edits))?)?$/u, "")}/codex/images/${operation}`
  const upstreamUrl = new URL(imagesUrl)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardCodexImages(
  request: Request,
  operation: CodexImagesOperation,
  baseUrl: string = CODEX_API_BASE_URL,
): Promise<Response> {
  const headers = buildCodexRequestHeaders(request.headers)
  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  if (operation === "generations" && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const init: StreamingRequestInit = {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
    signal: AbortSignal.timeout(CODEX_IMAGES_TIMEOUT_MS),
  }

  const upstreamUrl = resolveCodexImagesUrl(request.url, operation, baseUrl)
  if (typeof Bun !== "undefined") {
    return await fetch(upstreamUrl, init)
  }

  // Node and Undici expose separate fetch types, but their streamed request
  // and response objects are runtime-compatible here.
  return (await undiciFetch(upstreamUrl, {
    ...init,
    dispatcher: codexImagesDispatcher,
  } as unknown as UndiciRequestInit)) as unknown as Response
}
