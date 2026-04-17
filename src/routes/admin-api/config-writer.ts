import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type { AppConfig } from "~/lib/config"

import { PATHS } from "~/lib/paths"

export async function writeConfigFile(config: AppConfig): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })

  const content = `${JSON.stringify(config, null, 2)}\n`
  const tmpPath = `${PATHS.CONFIG_PATH}.tmp-${randomUUID()}`

  try {
    await fs.writeFile(tmpPath, content, "utf8")
    try {
      await fs.chmod(tmpPath, 0o600)
    } catch {
      // Ignore chmod errors (e.g. unsupported filesystem).
    }
    await fs.rename(tmpPath, PATHS.CONFIG_PATH)
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}
