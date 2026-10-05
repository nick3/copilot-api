import { z } from "zod"

import { GITHUB_COPILOT_PROVIDER } from "./github-copilot-provider"

import {
  invalidateConfigCache,
  readEditableConfigFromDisk,
  writeConfigToDisk,
  type AppConfig,
  type ProviderConfig,
} from "./config-store"
import { PATHS } from "./paths"
import type { ProviderManagementConfig } from "./types/provider-management"
export type {
  ProviderManagementConfig,
  ProviderManagementUpdate,
} from "./types/provider-management"

const updateSchema = z
  .object({
    providers: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean().optional(),
            codexModels: z
              .array(z.string().trim().min(1))
              .nullable()
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

export function getProviderCodexModels(
  provider: ProviderConfig | null | undefined,
): Array<string> | undefined {
  const models = provider?.codexModels
  if (!Array.isArray(models) || !models.every((id) => typeof id === "string")) {
    return undefined
  }
  return [...new Set(models.map((id) => id.trim()).filter(Boolean))]
}

export function isProviderCodexModelVisible(
  provider: ProviderConfig | null | undefined,
  modelId: string,
): boolean {
  if (provider?.enabled === false) return false
  const models = getProviderCodexModels(provider)
  return models === undefined || models.includes(modelId)
}

export function getProviderManagementConfig(
  config: AppConfig = readEditableConfigFromDisk(),
): ProviderManagementConfig {
  const providers: NonNullable<AppConfig["providers"]> = {
    [GITHUB_COPILOT_PROVIDER]: {},
    ...config.providers,
  }
  return {
    configPath: PATHS.CONFIG_PATH,
    providers: Object.entries(providers)
      .filter(([name]) => name !== "copilot")
      .map(([name, provider]) => ({
        name,
        type:
          name === GITHUB_COPILOT_PROVIDER ? "github-copilot" : (
            (provider.type ?? "anthropic")
          ),
        enabled: provider.enabled !== false,
        codexModels: getProviderCodexModels(provider),
      })),
  }
}

export function applyProviderManagementUpdate(
  config: AppConfig,
  input: unknown,
): AppConfig {
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? "Invalid provider update",
    )
  }
  const { providers: updates } = parsed.data
  const providers = { ...config.providers }
  for (const [name, update] of Object.entries(updates ?? {})) {
    if (
      name === "copilot"
      || (name !== GITHUB_COPILOT_PROVIDER && !Object.hasOwn(providers, name))
    ) {
      throw new Error(`Provider '${name}' is not configured`)
    }
    const provider = { ...providers[name] }
    if (update.enabled !== undefined) provider.enabled = update.enabled
    if (update.codexModels === null) {
      delete provider.codexModels
    } else if (update.codexModels !== undefined) {
      provider.codexModels = [...new Set(update.codexModels)]
    }
    providers[name] = provider
  }
  return {
    ...config,
    ...(updates !== undefined ? { providers } : {}),
  }
}

export function saveProviderManagementConfig(
  input: unknown,
): ProviderManagementConfig {
  const updated = applyProviderManagementUpdate(
    readEditableConfigFromDisk(),
    input,
  )
  writeConfigToDisk(updated)
  invalidateConfigCache()
  return getProviderManagementConfig(updated)
}
