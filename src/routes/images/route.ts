import { Hono, type Context } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonLazy } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  forwardCodexImages,
  type CodexImagesOperation,
} from "~/services/codex/images"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("images-handler")

export const imageRoutes = new Hono()
export const imageRouteDependencies = { debugJsonLazy }

function getContentMetadata(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
  }
}

/**
 * Handles Codex images proxying. Pass `resolvedProviderConfig` when the
 * caller already resolved the codex provider to avoid a second resolve.
 */
export async function handleCodexImages(
  c: Context,
  operation: CodexImagesOperation,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  try {
    const codexProviderConfig =
      resolvedProviderConfig ?? (await resolveProviderConfig("codex"))
    if (!codexProviderConfig) {
      return c.json(
        {
          error: {
            message: "Provider 'codex' not found or disabled",
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    if (operation === "generations") {
      await imageRouteDependencies.debugJsonLazy(
        logger,
        "images.generations.codex.request",
        async () => ({
          body: await c.req.raw.clone().text(),
        }),
      )
    } else {
      debugJson(
        logger,
        "images.edits.codex.request",
        getContentMetadata(c.req.raw.headers),
      )
    }

    const upstreamResponse = await forwardCodexImages(
      c.req.raw,
      operation,
      codexProviderConfig.baseUrl,
    )
    debugJson(logger, `images.${operation}.codex.response`, {
      ...getContentMetadata(upstreamResponse.headers),
      statusCode: upstreamResponse.status,
    })
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error(`images.${operation}.codex.error`, { error })
    return await forwardError(c, error)
  }
}

imageRoutes.post("/generations", (c) => handleCodexImages(c, "generations"))
imageRoutes.post("/edits", (c) => handleCodexImages(c, "edits"))
