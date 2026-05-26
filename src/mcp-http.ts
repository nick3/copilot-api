import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import consola from "consola"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "srvx"

import {
  DEFAULT_MCP_HTTP_PATH,
  type McpHttpServerOptions,
} from "~/mcp-http-config"
import { createToolSearchMcpServer } from "~/mcp-server"

export const mcpHttpCorsOptions = {
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Last-Event-ID",
    "MCP-Protocol-Version",
    "Mcp-Session-Id",
    "mcp-protocol-version",
    "mcp-session-id",
  ],
  exposeHeaders: [
    "MCP-Protocol-Version",
    "Mcp-Session-Id",
    "mcp-protocol-version",
    "mcp-session-id",
  ],
}

export const handleStreamableHttpMcpRequest = async (
  request: Request,
): Promise<Response> => {
  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    })
    const server = createToolSearchMcpServer()
    server.server.onerror = (error) => {
      consola.warn("MCP HTTP protocol error", {
        method: request.method,
        url: request.url,
        message: error.message,
      })
    }

    await server.connect(transport)
    return await transport.handleRequest(request)
  } catch (error) {
    consola.error("Failed to handle MCP HTTP request", error)

    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      },
      { status: 500 },
    )
  }
}

export const createMcpHttpApp = (path = DEFAULT_MCP_HTTP_PATH): Hono => {
  const app = new Hono()

  app.use("*", cors(mcpHttpCorsOptions))
  app.get("/", (c) => c.text("MCP server running"))
  app.all(path, (c) => handleStreamableHttpMcpRequest(c.req.raw))

  return app
}

export const runMcpHttpServer = (options: McpHttpServerOptions): void => {
  const app = createMcpHttpApp(options.path)
  const endpoint = `http://${options.host}:${options.port}${options.path}`

  consola.warn(
    "MCP Streamable HTTP is unauthenticated. Bind only to trusted networks.",
  )
  consola.info(`MCP endpoint: ${endpoint}`)

  serve({
    fetch: app.fetch,
    hostname: options.host,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })
}
