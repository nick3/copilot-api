import type { AppConfig } from "~/lib/config"

import { writeConfigToDisk } from "~/lib/config"

export function writeConfigFile(config: AppConfig): Promise<void> {
  return Promise.resolve().then(() => writeConfigToDisk(config))
}
