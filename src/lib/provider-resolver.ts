import {
  getRawProviderConfig,
  getProviderConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { state } from "~/lib/state"
import { setupCodexToken } from "~/lib/token"

function isMissingCodexCredentialsError(error: unknown): boolean {
  return (
    error instanceof Error
    && error.message
      === "Codex credentials not found. Run `copilot-api auth login --provider codex` first."
  )
}

export async function resolveProviderConfig(
  providerName: string,
): Promise<ResolvedProviderConfig | null> {
  const normalizedProviderName = providerName.trim()
  if (!normalizedProviderName) {
    return null
  }

  if (normalizedProviderName === "codex") {
    const rawProviderConfig = getRawProviderConfig(normalizedProviderName)
    if (rawProviderConfig?.enabled === false) {
      return null
    }

    try {
      await setupCodexToken()
    } catch (error) {
      if (isMissingCodexCredentialsError(error)) {
        return null
      }
      throw error
    }

    const providerConfig = getProviderConfig(normalizedProviderName)
    if (!providerConfig) {
      return null
    }

    return {
      ...providerConfig,
      apiKey: state.codexAccessToken ?? providerConfig.apiKey,
    }
  }

  return getProviderConfig(normalizedProviderName)
}
