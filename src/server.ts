import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { createAuthMiddleware } from "~/lib/request-auth"
import { traceIdMiddleware } from "~/lib/trace"
import {
  DEFAULT_MCP_HTTP_PATH,
  isMcpHttpEnabledFromEnv,
} from "~/mcp-http-config"
import { handleStreamableHttpMcpRequest, mcpHttpCorsOptions } from "~/mcp-http"
import { alphaSearchRoutes } from "~/routes/alpha-search/route"

import { zstdDecompressionMiddleware } from "./lib/zstd-request"
import { adminApiRoutes } from "./routes/admin-api/route"
import { adminRoutes } from "./routes/admin/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { imageRoutes } from "./routes/images/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerAlphaSearchRoutes } from "./routes/provider/alpha-search/route"
import { providerImageRoutes } from "./routes/provider/images/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { providerResponsesRoutes } from "./routes/provider/responses/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenRoute } from "./routes/token/route"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { usageRoute } from "./routes/usage/route"

export interface CreateServerOptions {
  enableMcpHttp?: boolean
}

export function createServer(options: CreateServerOptions = {}): Hono {
  const app = new Hono()
  const enableMcpHttp = options.enableMcpHttp ?? isMcpHttpEnabledFromEnv()

  app.use(traceIdMiddleware)
  app.use(logger())
  app.use(zstdDecompressionMiddleware)

  if (enableMcpHttp) {
    app.use(DEFAULT_MCP_HTTP_PATH, cors(mcpHttpCorsOptions))
    app.all(DEFAULT_MCP_HTTP_PATH, (c) =>
      handleStreamableHttpMcpRequest(c.req.raw),
    )
  } else {
    app.all(DEFAULT_MCP_HTTP_PATH, (c) =>
      c.json(
        {
          error: {
            type: "mcp_http_disabled",
            message:
              "MCP Streamable HTTP is disabled. Start with --enable-mcp-http to expose /mcp.",
          },
        },
        404,
      ),
    )
  }

  app.use(cors())
  app.use(
    "*",
    createAuthMiddleware({
      allowUnauthenticatedPaths: ["/", DEFAULT_MCP_HTTP_PATH],
      allowUnauthenticatedPathPrefixes: ["/admin", "/api/admin"],
    }),
  )

  app.get("/", (c) => c.text("Server running"))

  app.route("/chat/completions", completionRoutes)
  app.route("/models", modelRoutes)
  app.route("/embeddings", embeddingRoutes)
  app.route("/usage", usageRoute)
  app.route("/token-usage", tokenUsageRoute)
  app.route("/token", tokenRoute)
  app.route("/responses", responsesRoutes)
  app.route("/alpha/search", alphaSearchRoutes)
  app.route("/images", imageRoutes)

  app.route("/admin", adminRoutes)
  app.route("/api/admin", adminApiRoutes)

  app.route("/v1/chat/completions", completionRoutes)
  app.route("/v1/models", modelRoutes)
  app.route("/v1/embeddings", embeddingRoutes)
  app.route("/v1/responses", responsesRoutes)
  app.route("/v1/alpha/search", alphaSearchRoutes)
  app.route("/v1/images", imageRoutes)

  app.route("/v1/messages", messageRoutes)

  app.route("/:provider/v1/messages", providerMessageRoutes)
  app.route("/:provider/v1/models", providerModelRoutes)
  app.route("/:provider/v1/responses", providerResponsesRoutes)
  app.route("/:provider/v1/alpha/search", providerAlphaSearchRoutes)
  app.route("/:provider/v1/images", providerImageRoutes)

  app.route("/:provider/models", providerModelRoutes)
  app.route("/:provider/responses", providerResponsesRoutes)
  app.route("/:provider/alpha/search", providerAlphaSearchRoutes)
  app.route("/:provider/images", providerImageRoutes)

  return app
}

export const server = createServer()
