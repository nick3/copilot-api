import type { ConsolaInstance } from "consola"

import type { ResolvedProviderConfig } from "~/lib/config"
import { debugJson, debugJsonLazy } from "~/lib/logger"
import type { CodexImagesOperation } from "~/services/codex/images"
import {
  createProviderProxyResponse,
  forwardProviderImages,
} from "~/services/providers/provider-proxy"

export interface ProviderImagesForwardLogContext {
  logger: ConsolaInstance
  provider: string
}

/**
 * Forwards an images request to a configured provider with debug logging.
 * Shared by the top-level images routes (model mapping) and the
 * provider-scoped images routes so both log and proxy identically.
 */
export async function forwardProviderImagesWithLogging(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  operation: CodexImagesOperation,
  { logger, provider }: ProviderImagesForwardLogContext,
): Promise<Response> {
  if (operation === "generations") {
    await debugJsonLazy(
      logger,
      `provider.images.${operation}.request`,
      async () => ({
        body: await request.clone().text(),
        provider,
      }),
    )
  } else {
    debugJson(logger, `provider.images.${operation}.request`, {
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
      provider,
    })
  }

  const upstreamResponse = await forwardProviderImages(
    providerConfig,
    request,
    operation,
  )
  debugJson(logger, `provider.images.${operation}.response`, {
    contentType: upstreamResponse.headers.get("content-type"),
    contentLength: upstreamResponse.headers.get("content-length"),
    provider,
    statusCode: upstreamResponse.status,
  })
  return createProviderProxyResponse(upstreamResponse)
}
