import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJsonLazy } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { handleCodexAlphaSearch } from "~/routes/alpha-search/route"
import {
  createProviderProxyResponse,
  forwardProviderAlphaSearch,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-alpha-search-handler")

export const providerAlphaSearchRoutes = new Hono()

providerAlphaSearchRoutes.post("/", async (c) => {
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
      return await handleCodexAlphaSearch(c, providerConfig)
    }

    await debugJsonLazy(logger, "provider.alpha_search.request", async () => ({
      body: await c.req.raw.clone().text(),
      provider,
    }))

    const upstreamResponse = await forwardProviderAlphaSearch(
      providerConfig,
      c.req.raw,
    )

    await debugJsonLazy(logger, "provider.alpha_search.response", async () => ({
      body: await upstreamResponse.clone().text(),
      provider,
      statusCode: upstreamResponse.status,
    }))

    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error("provider.alpha_search.error", { provider, error })
    return await forwardError(c, error)
  }
})
