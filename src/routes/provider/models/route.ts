import { type Context, Hono } from "hono"

import { getProviderConfig, type ResolvedProviderConfig } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import {
  createProviderProxyResponse,
  forwardProviderModels,
} from "~/services/providers/anthropic-proxy"

const logger = createHandlerLogger("provider-models-handler")

type ProviderConfigResolver = (
  provider: string,
) => ResolvedProviderConfig | null

const getProviderFetch = (c: Context): typeof fetch =>
  (c.get("providerFetch" as never) as typeof fetch | undefined) ?? fetch

const resolveProviderConfig = (
  c: Context,
  provider: string,
): ResolvedProviderConfig | null => {
  const resolver = c.get("providerConfigResolver" as never) as
    | ProviderConfigResolver
    | undefined
  return (resolver ?? getProviderConfig)(provider)
}

export const providerModelRoutes = new Hono()

providerModelRoutes.get("/", async (c) => {
  const provider = c.req.param("provider") ?? ""

  try {
    const providerConfig = resolveProviderConfig(c, provider)
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

    const upstreamResponse = await forwardProviderModels(
      providerConfig,
      c.req.raw.headers,
      getProviderFetch(c),
    )

    logger.debug("provider.models.response", {
      provider,
      statusCode: upstreamResponse.status,
    })

    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error("provider.models.error", {
      provider,
      error,
    })
    return await forwardError(c, error)
  }
})
