import consola from "consola"
import fs from "node:fs/promises"

import type { AccountContext } from "~/lib/types/account"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { isCopilotUseLocalModelsEnabled } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { accountFromState } from "~/lib/state"

import { copilotFetch } from "./copilot-fetch"
import localModelsData from "./local-models.json" with { type: "json" }

export const getModels = async (
  account?: AccountContext,
  options?: {
    requestId?: string
  },
) => {
  if (isCopilotUseLocalModelsEnabled()) {
    const models = structuredClone(localModelsData) as ModelsResponse
    for (const model of models.data) {
      if (model.policy?.state === "disabled") {
        model.model_picker_enabled = true
      }
    }
    consola.info(`Loaded ${models.data.length} models from local file`)
    return models
  }

  const ctx = account ?? accountFromState()
  const response = await copilotFetch(
    `${copilotBaseUrl(ctx)}/models`,
    {
      headers: copilotModelsHeaders(ctx),
    },
    {
      requestId: options?.requestId,
      callSite: "models",
      capturable: false,
    },
  )

  if (!response.ok) {
    const errorText = await response.clone().text()

    consola.error("Failed to get models response body", errorText)

    throw new HTTPError("Failed to get models", response)
  }

  const models = (await response.json()) as ModelsResponse

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
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
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
  adaptive_thinking?: boolean
  reasoning_effort?: Array<string>
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface ModelTokenPriceTier {
  cache_price?: number
  cache_write_price?: number
  context_max?: number
  input_price?: number
  output_price?: number
}

export interface ModelTokenPrices extends ModelTokenPriceTier {
  batch_size?: number
  default?: ModelTokenPriceTier
  long_context?: ModelTokenPriceTier
}

interface ModelBilling {
  is_premium?: boolean
  multiplier?: number
  token_prices?: ModelTokenPrices
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
