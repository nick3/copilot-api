import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { createMcpToolSearchSentinel } from "~/lib/tool-search"

export const MCP_TOOL_SEARCH_SERVER_NAME = "tool_search"
export const MCP_TOOL_SEARCH_SERVER_VERSION = "1.0.0"
export const MCP_TOOL_SEARCH_TOOL_NAME = "search"

export const createToolSearchMcpServer = (): McpServer => {
  const server = new McpServer({
    name: MCP_TOOL_SEARCH_SERVER_NAME,
    version: MCP_TOOL_SEARCH_SERVER_VERSION,
  })

  server.registerTool(
    MCP_TOOL_SEARCH_TOOL_NAME,
    {
      title: "Tool Search Bridge",
      description:
        "Load deferred tools by exact name through the Copilot API tool_search bridge.",
      inputSchema: {
        names: z
          .string()
          .describe(
            'Comma-separated exact deferred tool names to load, for example "TaskList,TaskGet,mcp__fetch__fetch".',
          ),
      },
      _meta: {
        "anthropic/alwaysLoad": true,
      },
    },
    ({ names }) => ({
      content: [
        {
          type: "text",
          text: createMcpToolSearchSentinel(names),
        },
      ],
    }),
  )

  return server
}
