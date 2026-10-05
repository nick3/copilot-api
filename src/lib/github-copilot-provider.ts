import { getConfig, type AppConfig } from "./config-store"
import { HTTPError } from "./error"

export const GITHUB_COPILOT_PROVIDER = "github-copilot"

// Missing configuration preserves the legacy builtin Copilot behavior.
export function isGitHubCopilotEnabled(
  config: AppConfig = getConfig(),
): boolean {
  return config.providers?.[GITHUB_COPILOT_PROVIDER]?.enabled !== false
}

export function assertGitHubCopilotEnabled(): void {
  if (!isGitHubCopilotEnabled()) {
    throw new HTTPError(
      "GitHub Copilot provider is disabled",
      Response.json(
        {
          error: {
            message: "GitHub Copilot provider is disabled",
            type: "provider_disabled",
          },
        },
        { status: 403 },
      ),
    )
  }
}
