export const MCP_HTTP_ENABLED_ENV = "COPILOT_API_ENABLE_MCP_HTTP"
export const MCP_HTTP_ALLOWED_ORIGINS_ENV =
  "COPILOT_API_MCP_HTTP_ALLOWED_ORIGINS"
export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1"
export const DEFAULT_MCP_HTTP_PORT = 4142
export const DEFAULT_MCP_HTTP_PATH = "/mcp"

const LOOPBACK_CORS_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

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

export function parseMcpHttpAllowedOrigins(
  value: string | undefined = process.env[MCP_HTTP_ALLOWED_ORIGINS_ENV],
): Array<string> {
  return (
    value
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? []
  )
}

function isLoopbackCorsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)

    return (
      (url.protocol === "http:" || url.protocol === "https:")
      && LOOPBACK_CORS_HOSTS.has(url.hostname)
    )
  } catch {
    return false
  }
}

export function resolveMcpHttpCorsOrigin(
  origin: string | undefined,
  allowedOrigins = parseMcpHttpAllowedOrigins(),
): string | undefined {
  if (!origin) {
    return undefined
  }

  if (allowedOrigins.includes("*")) {
    return "*"
  }

  if (allowedOrigins.includes(origin) || isLoopbackCorsOrigin(origin)) {
    return origin
  }

  return undefined
}
