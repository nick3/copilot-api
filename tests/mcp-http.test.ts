import { describe, expect, test } from "bun:test"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { parseMcpToolSearchSentinel } from "~/lib/tool-search"
import { MCP_HTTP_ENABLED_ENV } from "~/mcp-http-config"
import { createMcpHttpApp } from "~/mcp-http"
import { createToolSearchMcpServer } from "~/mcp-server"
import { createServer } from "~/server"

interface JsonRpcResponse {
  error?: {
    code: number
    message: string
  }
  id: number | null
  jsonrpc: "2.0"
  result?: unknown
}

interface ToolListResult {
  tools: Array<{ name: string }>
}

interface ToolCallResult {
  content: Array<{ text: string; type: string }>
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()

function createMcpRequest(method: string, params: unknown, id = 1): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  })
}

async function readJsonRpcResponse(
  response: Response,
): Promise<JsonRpcResponse> {
  return (await response.json()) as JsonRpcResponse
}

function createInitializeRequest(id = 1): Request {
  return createMcpRequest(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "copilot-api-test",
        version: "1.0.0",
      },
    },
    id,
  )
}

function runMcpCli(...args: Array<string>) {
  return Bun.spawnSync({
    cmd: [process.execPath, "run", "./src/main.ts", "mcp", ...args],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: "",
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })
}

describe("MCP Streamable HTTP", () => {
  test("keeps the stdio CLI path free of static HTTP imports", () => {
    const source = fs.readFileSync(
      new URL("../src/mcp.ts", import.meta.url),
      "utf8",
    )

    expect(source).not.toMatch(/from\s+["'][^"']*mcp-http["']/)
    expect(source).toContain('await import("./mcp-http")')
  })

  test("handles initialize requests without creating a session id", async () => {
    const app = createMcpHttpApp()
    const response = await app.fetch(createInitializeRequest())
    const body = await readJsonRpcResponse(response)

    expect(response.status).toBe(200)
    expect(response.headers.get("mcp-session-id")).toBeNull()
    expect(body.id).toBe(1)
    expect(body.error).toBeUndefined()
    expect(body.result).toMatchObject({
      serverInfo: {
        name: "tool_search",
        version: "1.0.0",
      },
    })
  })

  test("creates a fresh stateless transport for repeated clients", async () => {
    const app = createMcpHttpApp()

    const first = await app.fetch(createInitializeRequest(1))
    const second = await app.fetch(createInitializeRequest(2))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await readJsonRpcResponse(first)).id).toBe(1)
    expect((await readJsonRpcResponse(second)).id).toBe(2)
  })

  test("SDK rejects reused stateless transports", async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    })
    const server = createToolSearchMcpServer()

    await server.connect(transport)
    await transport.handleRequest(createInitializeRequest(1))

    let thrown: unknown
    try {
      await transport.handleRequest(createInitializeRequest(2))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain(
      "Stateless transport cannot be reused across requests",
    )
  })

  test("lists and calls the shared search tool", async () => {
    const app = createMcpHttpApp()

    const listResponse = await app.fetch(createMcpRequest("tools/list", {}, 3))
    const listBody = await readJsonRpcResponse(listResponse)
    const listResult = listBody.result as ToolListResult

    expect(listResponse.status).toBe(200)
    expect(listResult.tools.map((tool) => tool.name)).toContain("search")

    const callResponse = await app.fetch(
      createMcpRequest(
        "tools/call",
        {
          name: "search",
          arguments: {
            names: "TaskList,mcp__fetch__fetch",
          },
        },
        4,
      ),
    )
    const callBody = await readJsonRpcResponse(callResponse)
    const callResult = callBody.result as ToolCallResult
    const text = callResult.content[0]?.text

    expect(callResponse.status).toBe(200)
    expect(parseMcpToolSearchSentinel(text ?? "")).toEqual({
      type: "copilot_api_tool_search",
      names: ["TaskList", "mcp__fetch__fetch"],
    })
  })

  test("returns clear errors for malformed and unsupported requests", async () => {
    const app = createMcpHttpApp()

    const malformed = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: "{",
      }),
    )
    const unsupported = await app.fetch(
      new Request("http://localhost/mcp", { method: "PUT" }),
    )

    expect(malformed.status).toBe(400)
    expect((await readJsonRpcResponse(malformed)).error?.message).toContain(
      "Parse error",
    )
    expect(unsupported.status).toBe(405)
  })

  test("supports CORS preflight and GET event-stream headers", async () => {
    const app = createMcpHttpApp()

    const preflight = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "http://example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,mcp-protocol-version",
        },
      }),
    )
    const getStream = await app.fetch(
      new Request("http://localhost/mcp", {
        headers: {
          accept: "text/event-stream",
        },
      }),
    )

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "POST",
    )
    expect(getStream.status).toBe(200)
    expect(getStream.headers.get("content-type")).toContain("text/event-stream")
    await getStream.body?.cancel()
  })

  test("keeps main server /mcp disabled with a clear response", async () => {
    const previousApiKey = process.env.COPILOT_API_KEY
    process.env.COPILOT_API_KEY = "secret"

    try {
      const app = createServer({ enableMcpHttp: false })
      const response = await app.fetch(createInitializeRequest())
      const body = (await response.json()) as {
        error: { message: string; type: string }
      }

      expect(response.status).toBe(404)
      expect(body.error.type).toBe("mcp_http_disabled")
      expect(body.error.message).toContain("--enable-mcp-http")
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.COPILOT_API_KEY
      } else {
        process.env.COPILOT_API_KEY = previousApiKey
      }
    }
  })

  test("main server can enable /mcp from environment", async () => {
    const previousValue = process.env[MCP_HTTP_ENABLED_ENV]
    process.env[MCP_HTTP_ENABLED_ENV] = "true"

    try {
      const app = createServer()
      const response = await app.fetch(createInitializeRequest())

      expect(response.status).toBe(200)
    } finally {
      if (previousValue === undefined) {
        delete process.env[MCP_HTTP_ENABLED_ENV]
      } else {
        process.env[MCP_HTTP_ENABLED_ENV] = previousValue
      }
    }
  })

  test("main server preserves auth CORS preflight headers", async () => {
    const app = createServer({ enableMcpHttp: true })
    const response = await app.fetch(
      new Request("http://localhost/v1/models", {
        method: "OPTIONS",
        headers: {
          origin: "http://example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,x-api-key",
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PATCH",
    )
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization,x-api-key",
    )
  })

  test("main server /mcp bypasses API key auth only when enabled", async () => {
    const previousApiKey = process.env.COPILOT_API_KEY
    process.env.COPILOT_API_KEY = "secret"

    try {
      const app = createServer({ enableMcpHttp: true })
      const mcpResponse = await app.fetch(createInitializeRequest())
      const modelsResponse = await app.fetch(
        new Request("http://localhost/v1/models"),
      )

      expect(mcpResponse.status).toBe(200)
      expect(modelsResponse.status).toBe(401)
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.COPILOT_API_KEY
      } else {
        process.env.COPILOT_API_KEY = previousApiKey
      }
    }
  })

  test("rejects invalid standalone HTTP CLI options", () => {
    const invalidPort = runMcpCli("--transport", "http", "--port", "not-a-port")
    const invalidPath = runMcpCli("--transport", "http", "--path", "mcp")
    const stderr = `${decoder.decode(invalidPort.stderr)}\n${decoder.decode(
      invalidPath.stderr,
    )}`

    expect(invalidPort.exitCode).not.toBe(0)
    expect(invalidPath.exitCode).not.toBe(0)
    expect(stderr).toContain("--port must be an integer from 1 to 65535")
    expect(stderr).toContain("--path must start with /")
  })
})
