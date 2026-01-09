import fs from "node:fs/promises"

import type { AccountContext } from "~/lib/types/account"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { PATHS } from "~/lib/paths"
import { copilotFetchJsonWithRetry } from "~/lib/resilient-copilot-fetch"
import { accountFromState } from "~/lib/state"

export const getModels = async (account?: AccountContext) => {
  const ctx = account ?? accountFromState()
  if (!ctx.copilotToken) throw new Error("Copilot token not found")

  const accountId = ctx.id ?? "unknown"

  const url = `${copilotBaseUrl(ctx)}/models`
  const init: RequestInit = {
    method: "GET",
    headers: copilotHeaders(ctx),
  }

  const models = await copilotFetchJsonWithRetry<ModelsResponse>({
    accountId,
    operation: "GET /models",
    url,
    init,
    failureMessage: "Failed to get models",
  })

  // Persist models response for debugging/inspection.
  // Best effort: do not fail startup if the local write fails.
  try {
    await fs.mkdir(PATHS.APP_DIR, { recursive: true })
    await fs.writeFile(
      PATHS.MODELS_PATH,
      `${JSON.stringify(models, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    )
  } catch {
    // ignore
  }

  return models
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  max_thinking_budget?: number
  min_thinking_budget?: number
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

interface ModelBilling {
  is_premium?: boolean
  multiplier?: number
}

export interface Model {
  billing?: ModelBilling
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  supported_endpoints?: Array<string>
}
