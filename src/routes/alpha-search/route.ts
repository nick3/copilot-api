import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJsonLazy } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { forwardCodexAlphaSearch } from "~/services/codex/alpha-search"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("alpha-search-handler")

export const alphaSearchRoutes = new Hono()

alphaSearchRoutes.post("/", async (c) => {
  try {
    const codexProviderConfig = await resolveProviderConfig("codex")
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

    await debugJsonLazy(logger, "alpha_search.codex.request", async () => ({
      body: await c.req.raw.clone().text(),
    }))

    const upstreamResponse = await forwardCodexAlphaSearch(
      c.req.raw,
      codexProviderConfig.baseUrl,
    )
    await debugJsonLazy(logger, "alpha_search.codex.response", async () => ({
      body: await upstreamResponse.clone().text(),
      statusCode: upstreamResponse.status,
    }))
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error("alpha_search.codex.error", { error })
    return await forwardError(c, error)
  }
})
