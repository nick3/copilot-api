#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { defineCommand } from "citty"
import consola from "consola"

import {
  DEFAULT_MCP_HTTP_HOST,
  DEFAULT_MCP_HTTP_PATH,
  DEFAULT_MCP_HTTP_PORT,
  type McpHttpServerOptions,
} from "~/mcp-http-config"
import { createToolSearchMcpServer } from "~/mcp-server"

type McpTransport = "stdio" | "http"

interface McpCommandArgs {
  host?: string
  path?: string
  port?: string
  transport?: string
}

export const runMcpServer = async (): Promise<void> => {
  const server = createToolSearchMcpServer()

  await server.connect(new StdioServerTransport())
}

function parseMcpTransport(value: string | undefined): McpTransport {
  const transport = (value ?? "stdio").trim()

  if (transport === "stdio" || transport === "http") {
    return transport
  }

  throw new Error("--transport must be either stdio or http")
}

function parseMcpHttpPort(value: string | undefined): number {
  const portRaw = (value ?? String(DEFAULT_MCP_HTTP_PORT)).trim()

  if (!/^\d+$/.test(portRaw)) {
    throw new Error("--port must be an integer from 1 to 65535")
  }

  const port = Number.parseInt(portRaw, 10)
  if (port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535")
  }

  return port
}

export function parseMcpHttpOptions(
  args: Pick<McpCommandArgs, "host" | "path" | "port">,
): McpHttpServerOptions {
  const host = (args.host ?? DEFAULT_MCP_HTTP_HOST).trim()
  const path = (args.path ?? DEFAULT_MCP_HTTP_PATH).trim()

  if (host.length === 0) {
    throw new Error("--host must not be empty")
  }

  if (!path.startsWith("/")) {
    throw new Error("--path must start with /")
  }

  return {
    host,
    path,
    port: parseMcpHttpPort(args.port),
  }
}

export async function runMcpCommand(args: McpCommandArgs): Promise<void> {
  const transport = parseMcpTransport(args.transport)

  if (transport === "stdio") {
    await runMcpServer()
    return
  }

  const options = parseMcpHttpOptions(args)
  const { runMcpHttpServer } = await import("./mcp-http")
  runMcpHttpServer(options)
}

export const mcp = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Start the Copilot API MCP tool_search bridge over stdio or Streamable HTTP",
  },
  args: {
    transport: {
      type: "string",
      default: "stdio",
      description: "Transport to use: stdio or http",
    },
    port: {
      type: "string",
      default: String(DEFAULT_MCP_HTTP_PORT),
      description: "HTTP transport port",
    },
    host: {
      type: "string",
      default: DEFAULT_MCP_HTTP_HOST,
      description: "HTTP transport host",
    },
    path: {
      type: "string",
      default: DEFAULT_MCP_HTTP_PATH,
      description: "HTTP transport path",
    },
  },
  run({ args }) {
    return runMcpCommand(args).catch((error: unknown) => {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
  },
})
