import { Hono } from "hono"

import {
  getAliasTargetSet,
  getModelAliases,
  listEnabledProviders,
  resolveEffectiveProviderType,
  type CodexReasoningEffort,
  type ModelConfig,
  type ProviderType,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { getAvailableModels, toClientModelId } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type { Model } from "~/services/copilot/get-models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardProviderModels } from "~/services/providers/provider-proxy"

import { handleMergedCodexModels, isCodexUserAgent } from "./codex-models"
import type { SyntheticCodexModelCandidate } from "./codex-models-types"

export const modelRoutes = new Hono()

const logger = createHandlerLogger("models-handler")
const EPOCH_ISO = new Date(0).toISOString()
const RESPONSES_ENDPOINTS = new Set(["/responses", "ws:/responses"])
const MESSAGES_ENDPOINT = "/v1/messages"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

type ClientModel = Record<string, unknown> & {
  id: string
  object: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeCopilotModel(model: Model): ClientModel {
  const capabilities = model.capabilities
  const contextWindow = capabilities?.limits?.max_context_window_tokens ?? 0
  const clientId = toClientModelId(model.id)
  const is1m = contextWindow >= 1_000_000

  return {
    claude_model_id: is1m ? `${clientId}[1m]` : clientId,
    ...model,
    id: clientId,
    object: "model",
    type: "model",
    created: 0,
    created_at: EPOCH_ISO,
    owned_by: model.vendor,
    display_name: model.name,
  }
}

function getStringField(
  model: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = model[field]
  return typeof value === "string" && value.trim() ? value : undefined
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

  const id = `${provider}/${rawId}`
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
    id,
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
      const codexModels = getCodexModels().data
      return codexModels
        .map((model) => normalizeProviderModel(providerConfig.name, model))
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
    logger.warn("models.provider.skip_error", {
      provider,
      error,
    })
    return []
  }
}

async function getAggregatedModels(
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  const copilotModels = getCopilotAndAliasModels()
  const providerModelsByProvider = await Promise.all(
    listEnabledProviders().map((provider) =>
      getProviderModels(provider, requestHeaders),
    ),
  )

  const models = [...copilotModels, ...providerModelsByProvider.flat()]

  const seenModelIds = new Set<string>()
  return models.filter((model) => {
    if (seenModelIds.has(model.id)) {
      return false
    }

    seenModelIds.add(model.id)
    return true
  })
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

const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
])

async function getSyntheticCodexModels(
  requestHeaders: Headers,
  providers: Array<string>,
): Promise<Array<SyntheticCodexModelCandidate>> {
  const copilotModels = getCopilotCodexCandidates()
  const providerResults = await Promise.allSettled(
    providers.map((provider) =>
      getProviderCodexCandidates(provider, requestHeaders),
    ),
  )
  const providerModels = providerResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  )

  const baseCandidates = [...copilotModels, ...providerModels.flat()]
  const blockedTargets = getAliasTargetSet()
  const candidatesBySlug = new Map(
    baseCandidates.map((candidate) => [
      candidate.slug.toLowerCase(),
      candidate,
    ]),
  )
  const aliasCandidates = Object.entries(getModelAliases()).flatMap(
    ([alias, target]) => {
      const targetCandidate = candidatesBySlug.get(target.toLowerCase())
      if (!targetCandidate) return []
      return [
        {
          ...targetCandidate,
          slug: alias,
          displayName: alias,
          description: `${alias} alias for ${targetCandidate.displayName}.`,
        },
      ]
    },
  )
  const visibleCandidates = baseCandidates.filter(
    (candidate) => !blockedTargets.has(candidate.slug.toLowerCase()),
  )
  const seen = new Set<string>()
  return [...visibleCandidates, ...aliasCandidates].filter((candidate) => {
    if (seen.has(candidate.slug)) return false
    seen.add(candidate.slug)
    return true
  })
}

function getCopilotCodexCandidates(): Array<SyntheticCodexModelCandidate> {
  const candidates: Array<SyntheticCodexModelCandidate> = []
  for (const model of getAvailableModels()) {
    try {
      if (isCopilotMessagesFallbackModel(model)) {
        candidates.push(createCopilotCodexCandidate(model))
      }
    } catch (error) {
      logger.warn("models.codex.copilot_skip_error", {
        modelId: model.id,
        error,
      })
    }
  }
  return candidates
}

function isCopilotMessagesFallbackModel(model: Model): boolean {
  const endpoints = model.supported_endpoints ?? []
  return (
    endpoints.some(
      (endpoint) =>
        endpoint === MESSAGES_ENDPOINT
        || endpoint === CHAT_COMPLETIONS_ENDPOINT,
    )
    && !endpoints.some((endpoint) => RESPONSES_ENDPOINTS.has(endpoint))
    && model.capabilities.supports.tool_calls !== false
  )
}

function createCopilotCodexCandidate(
  model: Model,
): SyntheticCodexModelCandidate {
  const reasoningEfforts = normalizeReasoningEfforts(
    model.capabilities.supports.reasoning_effort,
  )
  const usesNativeMessages =
    model.supported_endpoints?.includes(MESSAGES_ENDPOINT)
  return {
    slug: toClientModelId(model.id),
    displayName: model.name,
    description:
      usesNativeMessages ?
        `${model.name} through the Copilot Messages adapter.`
      : `${model.name} through the Copilot Messages-to-Chat adapter.`,
    contextWindow: positiveNumber(
      model.capabilities.limits.max_context_window_tokens,
      256_000,
    ),
    maxOutputTokens: positiveNumber(
      model.capabilities.limits.max_output_tokens,
      32_000,
    ),
    inputModalities:
      model.capabilities.supports.vision ? ["text", "image"] : ["text"],
    reasoningEfforts,
    defaultReasoningEffort: selectDefaultReasoningEffort(reasoningEfforts),
    supportsParallelToolCalls: Boolean(
      model.capabilities.supports.parallel_tool_calls,
    ),
  }
}

async function getProviderCodexCandidates(
  provider: string,
  requestHeaders: Headers,
): Promise<Array<SyntheticCodexModelCandidate>> {
  if (provider === "codex") return []

  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig || providerConfig.name === "codex") return []

    const remoteModels = await getProviderModelRecords(
      providerConfig,
      requestHeaders,
    )
    const remoteById = new Map(
      remoteModels.flatMap((model) => {
        const id = getStringField(model, "id")
        return id ? [[id, model] as const] : []
      }),
    )
    const modelIds = new Set([
      ...remoteById.keys(),
      ...Object.keys(providerConfig.models ?? {}),
    ])

    const candidates: Array<SyntheticCodexModelCandidate> = []
    for (const modelId of modelIds) {
      const effectiveType = resolveEffectiveProviderType(
        providerConfig,
        modelId,
      )
      const usesMessagesFallback = isMessagesFallbackProviderType(effectiveType)
      if (!usesMessagesFallback && effectiveType !== "openai-responses") {
        continue
      }
      const modelConfig = providerConfig.models?.[modelId]
      if (modelConfig?.codex?.enabled === false) continue
      candidates.push(
        createProviderCodexCandidate(
          providerConfig,
          modelId,
          remoteById.get(modelId),
          modelConfig,
          effectiveType,
        ),
      )
    }
    return candidates
  } catch (error) {
    logger.warn("models.codex.provider_skip_error", { provider, error })
    return []
  }
}

function isMessagesFallbackProviderType(type: ProviderType): boolean {
  return type === "anthropic" || type === "openai-compatible"
}

async function getProviderModelRecords(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Array<Record<string, unknown>>> {
  try {
    const response = await forwardProviderModels(providerConfig, requestHeaders)
    if (!response.ok) {
      logger.warn("models.codex.provider_skip_non_ok", {
        provider: providerConfig.name,
        statusCode: response.status,
      })
      return []
    }
    const body = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) return []
    return body.data.filter(isRecord)
  } catch (error) {
    logger.warn("models.codex.provider_models_error", {
      provider: providerConfig.name,
      error,
    })
    return []
  }
}

function createProviderCodexCandidate(
  providerConfig: ResolvedProviderConfig,
  modelId: string,
  remoteModel: Record<string, unknown> | undefined,
  modelConfig: ModelConfig | undefined,
  effectiveType: ProviderType,
): SyntheticCodexModelCandidate {
  const codexConfig = modelConfig?.codex
  const configuredReasoningEfforts = normalizeReasoningEfforts(
    codexConfig?.reasoningEfforts,
  )
  const reasoningEfforts =
    configuredReasoningEfforts.length > 0 ?
      configuredReasoningEfforts
    : normalizeRemoteReasoningEfforts(remoteModel)
  const configuredModalities = normalizeInputModalities(
    codexConfig?.inputModalities,
  )
  const remoteModalities = normalizeInputModalities(
    remoteModel?.input_modalities ?? remoteModel?.modalities,
  )
  const displayName =
    getStringField(remoteModel ?? {}, "display_name")
    ?? getStringField(remoteModel ?? {}, "name")
    ?? modelId
  const adapterName =
    effectiveType === "anthropic" ? "Messages" : "Messages-to-Chat"

  return {
    slug: `${providerConfig.name}/${modelId}`,
    catalogSlug: modelId,
    catalogMatchRequired: effectiveType === "openai-responses",
    providerName: providerConfig.name,
    displayName: `${displayName} (${providerConfig.name})`,
    description: `${displayName} through the ${providerConfig.name} ${adapterName} adapter.`,
    contextWindow: positiveNumber(
      codexConfig?.contextWindow
        ?? getFirstPositiveNumber(remoteModel, [
          "context_window",
          "context_length",
          "max_context_length",
          "max_model_len",
        ]),
      256_000,
    ),
    maxOutputTokens: positiveNumber(
      codexConfig?.maxOutputTokens
        ?? getFirstPositiveNumber(remoteModel, ["max_output_tokens"]),
      32_000,
    ),
    inputModalities: resolveInputModalities(
      providerConfig.name,
      configuredModalities,
      remoteModalities,
    ),
    reasoningEfforts,
    defaultReasoningEffort: selectDefaultReasoningEffort(
      reasoningEfforts,
      codexConfig?.defaultReasoningEffort,
    ),
    supportsParallelToolCalls:
      codexConfig?.supportsParallelToolCalls
      ?? getBooleanField(remoteModel, "supports_parallel_tool_calls")
      ?? false,
  }
}

function normalizeRemoteReasoningEfforts(
  model: Record<string, unknown> | undefined,
): Array<CodexReasoningEffort> {
  if (!model) return []
  const value = model.reasoning_efforts ?? model.supported_reasoning_levels
  if (!Array.isArray(value)) return []
  return normalizeReasoningEfforts(
    value.map((entry: unknown) =>
      isRecord(entry) && typeof entry.effort === "string" ?
        entry.effort
      : entry,
    ),
  )
}

function normalizeReasoningEfforts(
  value: unknown,
): Array<CodexReasoningEffort> {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter(
        (effort): effort is CodexReasoningEffort =>
          typeof effort === "string"
          && CODEX_REASONING_EFFORTS.has(effort as CodexReasoningEffort),
      ),
    ),
  ]
}

function normalizeInputModalities(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter(
        (modality): modality is "text" | "image" =>
          modality === "text" || modality === "image",
      ),
    ),
  ]
}

function resolveInputModalities(
  providerName: string,
  configuredModalities: Array<"text" | "image">,
  remoteModalities: Array<"text" | "image">,
): Array<"text" | "image"> {
  if (configuredModalities.length > 0) return configuredModalities
  if (providerName === "kimi") {
    const modalities: Array<"text" | "image"> =
      remoteModalities.length > 0 ? remoteModalities : ["text"]
    return [...new Set<"text" | "image">([...modalities, "image"])]
  }
  return remoteModalities.length > 0 ? remoteModalities : ["text"]
}

function selectDefaultReasoningEffort(
  efforts: Array<CodexReasoningEffort>,
  configured?: CodexReasoningEffort,
): CodexReasoningEffort {
  if (configured && efforts.includes(configured)) return configured
  if (efforts.includes("max")) return "max"
  return efforts[0] ?? "max"
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ?
      Math.floor(value)
    : fallback
}

function getFirstPositiveNumber(
  model: Record<string, unknown> | undefined,
  fields: Array<string>,
): number | undefined {
  if (!model) return undefined
  for (const field of fields) {
    const value = model[field]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return undefined
}

function getBooleanField(
  model: Record<string, unknown> | undefined,
  field: string,
): boolean | undefined {
  const value = model?.[field]
  return typeof value === "boolean" ? value : undefined
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
    if (isCodexUserAgent(c.req.header("user-agent"))) {
      const enabledProviders = listEnabledProviders()
      const codexProviderName = enabledProviders.find(
        (provider) => provider === "codex",
      )
      return await handleMergedCodexModels(
        c,
        getSyntheticCodexModels(c.req.raw.headers, enabledProviders),
        {
          includeCodexProviderAliases: codexProviderName !== undefined,
          codexProviderName,
        },
      )
    }

    return c.json(await getAggregatedModelsResponse(c.req.raw.headers))
  } catch (error) {
    return await forwardError(c, error)
  }
})
