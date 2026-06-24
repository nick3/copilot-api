import { Hono } from "hono"

import {
  getAliasTargetSet,
  getModelAliases,
  listEnabledProviders,
} from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { getAvailableModels, toClientModelId } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type { Model } from "~/services/copilot/get-models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardProviderModels } from "~/services/providers/provider-proxy"

export const modelRoutes = new Hono()

const logger = createHandlerLogger("models-handler")
const EPOCH_ISO = new Date(0).toISOString()

type ClientModel = Record<string, unknown> & {
  id: string
  object: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getStringField(
  model: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = model[field]
  return typeof value === "string" && value.trim() ? value : undefined
}

function normalizeCopilotModel(model: Model): ClientModel {
  const contextWindow =
    model.capabilities.limits?.max_context_window_tokens ?? 0
  const clientId = toClientModelId(model.id)
  const is1m = contextWindow >= 1_000_000

  return {
    claude_model_id: is1m ? `${clientId}[1m]` : clientId,
    id: clientId,
    object: "model",
    type: "model",
    created: 0,
    created_at: EPOCH_ISO,
    owned_by: model.vendor,
    display_name: model.name,
  }
}

function normalizeProviderModel(
  provider: string,
  model: unknown,
): ClientModel | null {
  if (!isRecord(model)) {
    return null
  }

  const rawId = getStringField(model, "id")
  if (!rawId) {
    return null
  }

  const name =
    getStringField(model, "display_name")
    ?? getStringField(model, "name")
    ?? rawId
  const ownedBy =
    getStringField(model, "owned_by")
    ?? getStringField(model, "vendor")
    ?? provider

  return {
    ...model,
    id: `${provider}/${rawId}`,
    object: getStringField(model, "object") ?? "model",
    type: getStringField(model, "type") ?? "model",
    created: typeof model.created === "number" ? model.created : 0,
    created_at: getStringField(model, "created_at") ?? EPOCH_ISO,
    owned_by: ownedBy,
    display_name: name,
  }
}

async function getProviderModels(
  provider: string,
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) {
      return []
    }

    if (providerConfig.name === "codex") {
      return getCodexModels()
        .data.map((model) => normalizeProviderModel(providerConfig.name, model))
        .filter((model): model is ClientModel => model !== null)
    }

    const response = await forwardProviderModels(providerConfig, requestHeaders)
    if (!response.ok) {
      logger.warn("models.provider.skip_non_ok", {
        provider,
        statusCode: response.status,
      })
      return []
    }

    const body = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) {
      logger.warn("models.provider.skip_invalid_body", { provider })
      return []
    }

    return body.data
      .map((model) => normalizeProviderModel(providerConfig.name, model))
      .filter((model): model is ClientModel => model !== null)
  } catch (error) {
    logger.warn("models.provider.skip_error", { provider, error })
    return []
  }
}

function getCopilotAndAliasModels(): Array<ClientModel> {
  const blockedTargets = getAliasTargetSet()
  const models = getAvailableModels()
    .filter((model) => !blockedTargets.has(model.id.toLowerCase()))
    .map(normalizeCopilotModel)

  const aliasModels = Object.keys(getModelAliases()).map((alias) => ({
    claude_model_id: alias,
    id: alias,
    object: "model",
    type: "model",
    created: 0,
    created_at: EPOCH_ISO,
    owned_by: "alias",
    display_name: alias,
  }))

  return [...models, ...aliasModels]
}

function dedupeModels(models: Array<ClientModel>): Array<ClientModel> {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false
    }
    seen.add(model.id)
    return true
  })
}

async function getAggregatedModels(
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  const providerModelsByProvider = await Promise.all(
    listEnabledProviders().map((provider) =>
      getProviderModels(provider, requestHeaders),
    ),
  )

  return dedupeModels([
    ...getCopilotAndAliasModels(),
    ...providerModelsByProvider.flat(),
  ])
}

export async function getAggregatedModelsResponse(requestHeaders: Headers) {
  return {
    object: "list",
    data: await getAggregatedModels(requestHeaders),
    has_more: false,
  }
}

modelRoutes.get("/", async (c) => {
  try {
    return c.json(await getAggregatedModelsResponse(c.req.raw.headers))
  } catch (error) {
    return await forwardError(c, error)
  }
})
