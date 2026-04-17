import { Hono, type Context } from "hono"

import type { AppConfig, DevModeConfig } from "~/lib/config"

import { getConfig, mergeConfigWithDefaults } from "~/lib/config"
import { isDevModeEnabled } from "~/lib/dev-mode"

import { writeConfigFile } from "./config-writer"

export const replayRoutes = new Hono()

replayRoutes.get("/dev-mode", (c) => {
  const dev = getConfig().devMode ?? { enabled: false, capture4xx: false }
  return c.json({
    enabled: dev.enabled,
    capture4xx: dev.capture4xx,
  })
})

replayRoutes.post("/dev-mode", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json(
      { error: { message: "Body must be valid JSON", type: "bad_request" } },
      400,
    )
  }

  if (
    typeof payload !== "object"
    || payload === null
    || Array.isArray(payload)
  ) {
    return c.json(
      { error: { message: "Body must be an object", type: "bad_request" } },
      400,
    )
  }

  const patch = payload as Partial<DevModeConfig>
  const current = getConfig().devMode ?? { enabled: false, capture4xx: false }
  const next: DevModeConfig = {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    capture4xx:
      typeof patch.capture4xx === "boolean" ?
        patch.capture4xx
      : current.capture4xx,
  }

  const config: AppConfig = { ...getConfig(), devMode: next }
  await writeConfigFile(config)
  mergeConfigWithDefaults()

  return c.json(next)
})

export function requireDevMode(c: Context): Response | null {
  if (!isDevModeEnabled()) {
    return c.json(
      {
        error: {
          message: "Developer mode disabled",
          type: "forbidden",
        },
      },
      403,
    )
  }
  return null
}
