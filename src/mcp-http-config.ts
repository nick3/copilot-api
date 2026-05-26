export const MCP_HTTP_ENABLED_ENV = "COPILOT_API_ENABLE_MCP_HTTP"
export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1"
export const DEFAULT_MCP_HTTP_PORT = 4142
export const DEFAULT_MCP_HTTP_PATH = "/mcp"

export interface McpHttpServerOptions {
  host: string
  path: string
  port: number
}

export function isMcpHttpEnabledValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()

  return (
    normalized === "1"
    || normalized === "true"
    || normalized === "yes"
    || normalized === "on"
  )
}

export function isMcpHttpEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isMcpHttpEnabledValue(env[MCP_HTTP_ENABLED_ENV])
}
