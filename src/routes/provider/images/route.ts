import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonLazy } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { handleCodexImages } from "~/routes/images/route"
import type { CodexImagesOperation } from "~/services/codex/images"
import {
  createProviderProxyResponse,
  forwardProviderImages,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-images-handler")

export const providerImageRoutes = new Hono()

function getContentMetadata(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
  }
}

async function handleProviderImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  const provider = c.req.param("provider") ?? ""

  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) {
      return c.json(
        {
          error: {
            message: `Provider '${provider}' not found or disabled`,
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    if (providerConfig.name === "codex") {
      return await handleCodexImages(c, operation, providerConfig)
    }

    if (operation === "generations") {
      await debugJsonLazy(
        logger,
        "provider.images.generations.request",
        async () => ({
          body: await c.req.raw.clone().text(),
          provider,
        }),
      )
    } else {
      debugJson(logger, "provider.images.edits.request", {
        ...getContentMetadata(c.req.raw.headers),
        provider,
      })
    }

    const upstreamResponse = await forwardProviderImages(
      providerConfig,
      c.req.raw,
      operation,
    )

    debugJson(logger, `provider.images.${operation}.response`, {
      ...getContentMetadata(upstreamResponse.headers),
      provider,
      statusCode: upstreamResponse.status,
    })

    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error(`provider.images.${operation}.error`, { provider, error })
    return await forwardError(c, error)
  }
}

providerImageRoutes.post("/generations", (c) =>
  handleProviderImages(c, "generations"),
)
providerImageRoutes.post("/edits", (c) => handleProviderImages(c, "edits"))
