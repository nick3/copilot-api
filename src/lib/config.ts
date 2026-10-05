import {
  getModelsDevModelApi,
  getModelsDevModelPricing,
  getModelsDevModelProviderType,
  getModelsDevProviderApi,
  getOpencodeGoModelProviderType,
} from "./models-dev-cache"
import consola from "consola"
import fs from "node:fs"

import { writeFileAtomically } from "./atomic-file"
import type { TokenUsagePricingConfig } from "./token-usage/pricing"
export type {
  TokenUsagePricingConfig,
  TokenUsagePricingTier,
} from "./token-usage/pricing"

import type { ReasoningEffort } from "~/lib/reasoning-effort"

import { PATHS } from "./paths"

export type LogLevel = "error" | "warn" | "info" | "debug"

export interface DevModeConfig {
  enabled: boolean
  capture4xx: boolean
  capture5xx: boolean
  captureOther: boolean
}

export interface QuotaRefreshConfig {
  enabled?: boolean
  intervalMinutes?: number
  startupDelaySeconds?: number
  staggerMinSeconds?: number
  staggerMaxSeconds?: number
}

export interface ResolvedQuotaRefreshConfig {
  enabled: boolean
  intervalMinutes: number
  startupDelaySeconds: number
  staggerMinSeconds: number
  staggerMaxSeconds: number
}

export type ConfiguredReasoningEffort = ReasoningEffort

export interface AppConfig {
  auth?: {
    apiKeys?: Array<string>
    allowLegacyApiKeyFallback?: boolean
  }
  providers?: Record<string, ProviderConfig>
  extraPrompts?: Record<string, string>
  smallModel?: string
  smallModels?: SmallModelsConfig
  accountAffinity?: boolean
  /** @deprecated */
  apiKey?: string
  /** @deprecated use contextManagement */
  responsesApiContextManagementModels?: Array<string>
  /** @deprecated use contextManagement */
  useResponsesApiContextManagement?: boolean
  contextManagement?: ContextManagementConfig
  modelResponsesApiCompactThresholds?: Record<string, number>
  modelReasoningEfforts?: Record<string, ConfiguredReasoningEffort>
  modelAliases?: Record<string, { target: string; allowOriginal?: boolean }>
  allowOriginalModelNamesForAliases?: boolean
  modelMappings?: Record<string, string>
  forceAgent?: boolean
  compactUseSmallModel?: boolean
  messageStartInputTokensFallback?: boolean
  modelRefreshIntervalHours?: number
  sessionAffinityRetentionDays?: number
  useMessagesApi?: boolean
  useResponsesApiWebSocket?: boolean
  upstreamTransport?: UpstreamTransportConfig
  anthropicApiKey?: string
  useResponsesApiWebSearch?: boolean
  alphaSearchCodexPriority?: boolean
  alphaSearchModel?: string
  // Copilot rejects Anthropic's web_search server tool on /v1/messages, so a
  // Claude request that only asks for web search is switched to this model.
  // A `provider/model` alias is passed straight through to that provider's
  // (websearch-capable) message API, while a plain GPT model runs the search
  // via /responses. Leave unset to disable (the tool is then stripped).
  // Mixing web_search with other tools is not supported.
  messageApiWebSearchModel?: string
  // Model used for Claude Code background security-monitor requests on
  // /v1/messages and provider message APIs: requests without tools, with
  // `stop_sequences: ["</block>"]` and a system block starting with
  // "You are a security monitor for autonomous AI coding agents.".
  // A `provider/model` alias is forwarded to that provider's message API on
  // the top-level route. Provider message routes use the configured value on
  // their current provider. Leave empty to disable (default).
  claudeAutoModel?: string
  claudeTokenMultiplier?: number
  logLevel?: LogLevel
  devMode?: DevModeConfig
  quotaRefresh?: QuotaRefreshConfig
  copilotUseLocalModels?: boolean
}

export interface SmallModelsConfig {
  [providerName: string]: string | undefined
}

export interface ContextManagementConfig {
  messages?: boolean
  responses?: boolean
}

export interface UpstreamTransportConfig {
  headersTimeoutMs?: number
  streamInactivityTimeoutMs?: number
  websocketMaxBufferedBytes?: number
  websocketMaxBufferedMessages?: number
  websocketOpenTimeoutMs?: number
  websocketPoolIdleTimeoutMs?: number
}

export const defaultUpstreamTransportConfig = {
  headersTimeoutMs: 5 * 60 * 1000,
  streamInactivityTimeoutMs: 5 * 60 * 1000,
  websocketMaxBufferedBytes: 8 * 1024 * 1024,
  websocketMaxBufferedMessages: 1024,
  websocketOpenTimeoutMs: 30_000,
  websocketPoolIdleTimeoutMs: 60_000,
} satisfies Required<UpstreamTransportConfig>

export interface ModelConfig {
  temperature?: number
  topP?: number
  topK?: number
  extraBody?: Record<string, unknown>
  contextCache?: boolean
  pricing?: TokenUsagePricingConfig
  supportPdf?: boolean
  toolContentSupportType?: Array<ToolContentSupportType>
  type?: ProviderType
  codex?: CodexModelCapabilitiesConfig
  reasoningField?: ModelReasoningField
}

export type ModelReasoningField = "reasoning" | "reasoning_content"

export interface CodexModelCapabilitiesConfig {
  enabled?: boolean
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: Array<"text" | "image">
  reasoningEfforts?: Array<CodexReasoningEffort>
  defaultReasoningEffort?: CodexReasoningEffort
  supportsParallelToolCalls?: boolean
}

export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"

export const PROVIDER_TYPE_ANTHROPIC = "anthropic" as const
export const SUPPORTED_PROVIDER_TYPES = [
  PROVIDER_TYPE_ANTHROPIC,
  "openai-compatible",
  "openai-responses",
] as const

export type ProviderAuthType =
  | "authorization"
  | "azure-entra"
  | "oauth2"
  | "x-api-key"
export type ProviderType = (typeof SUPPORTED_PROVIDER_TYPES)[number]
export type ToolContentSupportType = "array" | "image" | "pdf"

export function isSupportedProviderType(value: string): value is ProviderType {
  return SUPPORTED_PROVIDER_TYPES.includes(value as ProviderType)
}

export interface ProviderConfig {
  type?: string
  enabled?: boolean
  baseUrl?: string
  modelsDevProviderId?: string
  codexModels?: Array<string>
  apiKey?: string
  authType?: ProviderAuthType
  accountId?: string
  pricingCurrency?: string
  models?: Record<string, ModelConfig>
  adjustInputTokens?: boolean
}

export interface ResolvedProviderConfig {
  name: string
  type: ProviderType
  baseUrl: string
  modelsDevProviderId?: string
  codexModels?: Array<string>
  authTypeExplicit?: boolean
  apiKey: string
  authType: ProviderAuthType
  pricingCurrency?: string
  models?: Record<string, ModelConfig>
  adjustInputTokens?: boolean
}

const GPT_MODEL_PATTERN = /^gpt-(\d+)(?:\.(\d+))?/

function isGpt53OrAbove(model: string): boolean {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > 5) {
    return true
  }
  if (majorVersion !== 5) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= 3
}

export function isGpt56OrAbove(model: string): boolean {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > 5) {
    return true
  }
  if (majorVersion !== 5) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= 6
}

const DEFAULT_QUOTA_REFRESH_CONFIG: ResolvedQuotaRefreshConfig = {
  enabled: true,
  intervalMinutes: 360,
  startupDelaySeconds: 60,
  staggerMinSeconds: 2,
  staggerMaxSeconds: 5,
}

const MIN_QUOTA_REFRESH_INTERVAL_MINUTES = 30

const gpt5CommentaryPrompt = `# Working with the user

You interact with the user through a terminal. You have 2 ways of communicating with the users:  
- Share intermediary updates in \`commentary\` channel.  
- After you have completed all your work, send a message to the \`final\` channel.  

## Intermediary updates

- Intermediary updates go to the \`commentary\` channel.
- User updates are short updates while you are working, they are NOT final answers.
- You use 1-2 sentence user updates to communicate progress and new information to the user as you are doing work.
- Do not begin responses with conversational interjections or meta commentary. Avoid openers such as acknowledgements (“Done —”, “Got it”, “Great question, ”) or framing phrases.
- You provide user updates frequently, every 20s.
- Before exploring or doing substantial work, you start with a user update acknowledging the request and explaining your first step. You should include your understanding of the user request and explain what you will do. Avoid commenting on the request or using starters such as "Got it -" or "Understood -" etc.
- When exploring, e.g. searching, reading files, you provide user updates as you go, every 20s, explaining what context you are gathering and what you've learned. Vary your sentence structure when providing these updates to avoid sounding repetitive - in particular, don't start each sentence the same way.
- After you have sufficient context, and the work is substantial, you provide a longer plan (this is the only user update that may be longer than 2 sentences and can contain formatting).
- Before performing file edits of any kind, you provide updates explaining what edits you are making.
- As you are thinking, you very frequently provide updates even if not taking any actions, informing the user of your progress. You interrupt your thinking and send multiple updates in a row if thinking for more than 100 words.
- Tone of your updates MUST match your personality.`

const modelResponsesApiCompactThresholds = {
  "gpt-5.4": 272_000 * 0.8,
  "gpt-5.5": 272_000 * 0.8,
}

const defaultContextManagement = {
  messages: true,
  responses: false,
} satisfies Required<ContextManagementConfig>

export const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  providers: {},
  smallModels: { copilot: "gpt-6-luna", codex: "gpt-6-luna" },
  accountAffinity: true,
  contextManagement: defaultContextManagement,
  modelResponsesApiCompactThresholds,
  modelReasoningEfforts: {},
  allowOriginalModelNamesForAliases: false,
  modelMappings: {
    "codex-auto-review": "codex/codex-auto-review",
    "gpt-reserve": "codex/gpt-reserve",
  },
  forceAgent: false,
  compactUseSmallModel: true,
  messageStartInputTokensFallback: false,
  modelRefreshIntervalHours: 24,
  sessionAffinityRetentionDays: 7,
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  upstreamTransport: defaultUpstreamTransportConfig,
  useResponsesApiWebSearch: true,
  alphaSearchCodexPriority: true,
  alphaSearchModel: "gpt-6-luna",
  messageApiWebSearchModel: "gpt-6-luna",
  logLevel: "info",
  devMode: {
    enabled: false,
    capture4xx: false,
    capture5xx: false,
    captureOther: false,
  },
  quotaRefresh: DEFAULT_QUOTA_REFRESH_CONFIG,
  copilotUseLocalModels: false,
}

let cachedConfig: AppConfig | null = null

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeAuthApiKeys(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []

  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ]
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  if (!Number.isFinite(value)) return undefined
  if (value < 0) return undefined
  return value
}

function normalizeQuotaRefreshIntervalMinutes(value: unknown): number {
  const normalized = normalizeNonNegativeNumber(value)
  const minutes = normalized ?? DEFAULT_QUOTA_REFRESH_CONFIG.intervalMinutes

  if (minutes > 0 && minutes < MIN_QUOTA_REFRESH_INTERVAL_MINUTES) {
    return MIN_QUOTA_REFRESH_INTERVAL_MINUTES
  }

  return minutes
}

export function normalizeQuotaRefreshConfig(
  value: unknown,
): ResolvedQuotaRefreshConfig {
  const raw = isPlainObject(value) ? value : {}
  const staggerMinSeconds =
    normalizeNonNegativeNumber(raw.staggerMinSeconds)
    ?? DEFAULT_QUOTA_REFRESH_CONFIG.staggerMinSeconds
  const rawStaggerMaxSeconds =
    normalizeNonNegativeNumber(raw.staggerMaxSeconds)
    ?? DEFAULT_QUOTA_REFRESH_CONFIG.staggerMaxSeconds

  return {
    enabled:
      typeof raw.enabled === "boolean" ?
        raw.enabled
      : DEFAULT_QUOTA_REFRESH_CONFIG.enabled,
    intervalMinutes: normalizeQuotaRefreshIntervalMinutes(raw.intervalMinutes),
    startupDelaySeconds:
      normalizeNonNegativeNumber(raw.startupDelaySeconds)
      ?? DEFAULT_QUOTA_REFRESH_CONFIG.startupDelaySeconds,
    staggerMinSeconds,
    staggerMaxSeconds: Math.max(staggerMinSeconds, rawStaggerMaxSeconds),
  }
}

const LOG_LEVELS = new Set<LogLevel>(["error", "warn", "info", "debug"])

function normalizeLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") return undefined
  return LOG_LEVELS.has(value as LogLevel) ? (value as LogLevel) : undefined
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function ensureConfigFile(): void {
  try {
    fs.accessSync(PATHS.CONFIG_PATH, fs.constants.F_OK)
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error
    }

    writeFileAtomically(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
    )
  }
}

function readConfigFromDisk(): AppConfig {
  ensureConfigFile()
  const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
  if (!raw.trim()) {
    writeFileAtomically(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
    )
    return defaultConfig
  }

  try {
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    // Fail closed: falling back to the default config here would let the
    // startup merge overwrite the corrupt file (discarding providers, API
    // keys, and model mappings) and, because the default has no apiKeys,
    // silently disable API key authentication on normal routes.
    const message = `Config file is not valid JSON: ${PATHS.CONFIG_PATH}. Refusing to start with the default config. Fix the JSON syntax or delete the file to regenerate a fresh config.`
    consola.error(message, error)
    throw new Error(message, { cause: error })
  }
}

export function readEditableConfigFromDisk(): AppConfig {
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      return {}
    }
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {}
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Config file is not valid JSON: ${PATHS.CONFIG_PATH}`)
    }
    throw error
  }
}

export function writeConfigToDisk(config: AppConfig): void {
  writeFileAtomically(PATHS.CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}

export function setConfiguredApiKeys(apiKeys: Array<string>): Array<string> {
  const normalizedKeys = apiKeys
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
  const uniqueKeys = [...new Set(normalizedKeys)]

  const editableConfig = readEditableConfigFromDisk()
  const { apiKey: _legacyApiKey, ...currentConfig } = editableConfig
  writeConfigToDisk({
    ...currentConfig,
    auth: {
      ...editableConfig.auth,
      apiKeys: uniqueKeys,
      ...(uniqueKeys.length === 0 ? { allowLegacyApiKeyFallback: false } : {}),
    },
  })
  reloadConfig()
  return [...uniqueKeys]
}

function mergeDefaultConfig(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const defaultModelMappings = defaultConfig.modelMappings ?? {}
  const hasModelMappingChanges = config.modelMappings === undefined
  const extraPrompts = config.extraPrompts ?? {}
  const defaultExtraPrompts = defaultConfig.extraPrompts ?? {}
  const responsesApiCompactThresholds =
    config.modelResponsesApiCompactThresholds ?? {}
  const defaultResponsesApiCompactThresholds =
    defaultConfig.modelResponsesApiCompactThresholds ?? {}
  const modelReasoningEfforts = config.modelReasoningEfforts ?? {}
  const defaultModelReasoningEfforts = defaultConfig.modelReasoningEfforts ?? {}
  const hasForceAgent = typeof config.forceAgent === "boolean"
  const defaultForceAgent = defaultConfig.forceAgent ?? false
  const contextManagement = normalizeContextManagementConfig(config)
  const defaultContextManagementConfig = defaultConfig.contextManagement ?? {}

  const missingExtraPromptModels = Object.keys(defaultExtraPrompts).filter(
    (model) => !Object.hasOwn(extraPrompts, model),
  )

  const missingReasoningEffortModels = Object.keys(
    defaultModelReasoningEfforts,
  ).filter((model) => !Object.hasOwn(modelReasoningEfforts, model))
  const missingResponsesApiCompactThresholdModels = Object.keys(
    defaultResponsesApiCompactThresholds,
  ).filter((model) => !Object.hasOwn(responsesApiCompactThresholds, model))
  const missingContextManagementKeys = Object.keys(
    defaultContextManagementConfig,
  ).filter((key) => !Object.hasOwn(contextManagement, key))

  const hasExtraPromptChanges = missingExtraPromptModels.length > 0
  const hasReasoningEffortChanges = missingReasoningEffortModels.length > 0
  const hasForceAgentChanges = !hasForceAgent
  const hasResponsesApiCompactThresholdChanges =
    missingResponsesApiCompactThresholdModels.length > 0
  const hasContextManagementChanges = missingContextManagementKeys.length > 0

  if (
    !hasModelMappingChanges
    && !hasExtraPromptChanges
    && !hasReasoningEffortChanges
    && !hasForceAgentChanges
    && !hasResponsesApiCompactThresholdChanges
    && !hasContextManagementChanges
  ) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      modelMappings: config.modelMappings ?? { ...defaultModelMappings },
      contextManagement: {
        ...defaultContextManagementConfig,
        ...contextManagement,
      },
      extraPrompts: {
        ...defaultExtraPrompts,
        ...extraPrompts,
      },
      modelResponsesApiCompactThresholds: {
        ...defaultResponsesApiCompactThresholds,
        ...responsesApiCompactThresholds,
      },
      modelReasoningEfforts: {
        ...defaultModelReasoningEfforts,
        ...modelReasoningEfforts,
      },
      forceAgent: hasForceAgent ? config.forceAgent : defaultForceAgent,
    },
    changed: true,
  }
}

function normalizeContextManagementConfig(
  config: AppConfig,
): ContextManagementConfig {
  const value = config.contextManagement
  if (!value || typeof value !== "object") {
    return normalizeLegacyContextManagementConfig(config)
  }

  return {
    ...(typeof value.messages === "boolean" ?
      { messages: value.messages }
    : {}),
    ...(typeof value.responses === "boolean" ?
      { responses: value.responses }
    : {}),
  }
}

function normalizeLegacyContextManagementConfig(
  config: AppConfig,
): ContextManagementConfig {
  if (typeof config.useResponsesApiContextManagement !== "boolean") {
    return {}
  }

  return {
    messages: config.useResponsesApiContextManagement,
  }
}

function mergeDefaultAuth(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const authConfig = isPlainObject(config.auth) ? config.auth : undefined
  const rawApiKeys =
    Array.isArray(authConfig?.apiKeys) ? authConfig.apiKeys : undefined
  const normalizedApiKeys = normalizeAuthApiKeys(rawApiKeys)
  const nextAuth = {
    apiKeys: normalizedApiKeys,
    ...(typeof authConfig?.allowLegacyApiKeyFallback === "boolean" ?
      { allowLegacyApiKeyFallback: authConfig.allowLegacyApiKeyFallback }
    : {}),
  }

  if (authConfig && JSON.stringify(authConfig) === JSON.stringify(nextAuth)) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      auth: nextAuth,
    },
    changed: true,
  }
}

function mergeDefaultAccountAffinity(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  // Migration: map old freeModelLoadBalancing to accountAffinity
  const raw = config as Record<string, unknown>
  const hasOld = typeof raw.freeModelLoadBalancing === "boolean"
  const hasNew = typeof config.accountAffinity === "boolean"

  if (hasOld) {
    const next = { ...config } as Record<string, unknown>
    if (!hasNew) {
      next.accountAffinity = raw.freeModelLoadBalancing
    }
    delete next.freeModelLoadBalancing
    return { mergedConfig: next, changed: true }
  }

  if (hasNew) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      accountAffinity: defaultConfig.accountAffinity ?? true,
    },
    changed: true,
  }
}

function mergeDefaultModelRefreshInterval(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const normalized = normalizeNonNegativeNumber(
    config.modelRefreshIntervalHours,
  )

  if (normalized !== undefined) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      modelRefreshIntervalHours: defaultConfig.modelRefreshIntervalHours ?? 24,
    },
    changed: true,
  }
}

function mergeDefaultSessionAffinityRetention(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const normalized = normalizeNonNegativeNumber(
    config.sessionAffinityRetentionDays,
  )

  if (normalized !== undefined) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      sessionAffinityRetentionDays:
        defaultConfig.sessionAffinityRetentionDays ?? 7,
    },
    changed: true,
  }
}

function mergeDefaultLogLevel(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const normalized = normalizeLogLevel(config.logLevel)

  if (normalized !== undefined) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      logLevel: defaultConfig.logLevel ?? "info",
    },
    changed: true,
  }
}

function mergeDefaultDevMode(config: AppConfig): ConfigMergeResult {
  const current = config.devMode
  if (
    current
    && typeof current.enabled === "boolean"
    && typeof current.capture4xx === "boolean"
    && typeof current.capture5xx === "boolean"
    && typeof current.captureOther === "boolean"
  ) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      devMode: {
        enabled: current?.enabled === true,
        capture4xx: current?.capture4xx === true,
        capture5xx: current?.capture5xx === true,
        captureOther: current?.captureOther === true,
      },
    },
    changed: true,
  }
}

function mergeDefaultQuotaRefresh(config: AppConfig): ConfigMergeResult {
  const quotaRefresh = normalizeQuotaRefreshConfig(config.quotaRefresh)

  if (JSON.stringify(config.quotaRefresh) === JSON.stringify(quotaRefresh)) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      quotaRefresh,
    },
    changed: true,
  }
}

type ConfigMergeResult = {
  mergedConfig: AppConfig
  changed: boolean
}

type ConfigMergeFn = (config: AppConfig) => ConfigMergeResult

function applyConfigMerges(
  config: AppConfig,
  mergeFns: ReadonlyArray<ConfigMergeFn>,
): ConfigMergeResult {
  return mergeFns.reduce<ConfigMergeResult>(
    (acc, mergeFn) => {
      const result = mergeFn(acc.mergedConfig)
      return {
        mergedConfig: result.mergedConfig,
        changed: acc.changed || result.changed,
      }
    },
    { mergedConfig: config, changed: false },
  )
}

export function mergeConfigWithDefaults(): AppConfig {
  const config = readConfigFromDisk()

  const { mergedConfig, changed } = applyConfigMerges(config, [
    mergeDefaultAuth,
    mergeDefaultTransportConfig,
    mergeDefaultConfig,
    mergeDefaultAccountAffinity,
    mergeDefaultModelRefreshInterval,
    mergeDefaultSessionAffinityRetention,
    mergeDefaultLogLevel,
    mergeDefaultDevMode,
    mergeDefaultQuotaRefresh,
  ])

  if (changed) {
    try {
      writeConfigToDisk(mergedConfig)
    } catch (writeError) {
      consola.warn("Failed to write merged config defaults", writeError)
    }
  }

  cachedConfig = mergedConfig
  return mergedConfig
}

export function getConfig(): AppConfig {
  cachedConfig ??= applyConfigMerges(readConfigFromDisk(), [
    mergeDefaultConfig,
    mergeDefaultTransportConfig,
  ]).mergedConfig
  return cachedConfig
}

export function invalidateConfigCache(): void {
  cachedConfig = null
}

export function reloadConfig(): AppConfig {
  const previous = cachedConfig
  cachedConfig = null
  try {
    return mergeConfigWithDefaults()
  } catch (error) {
    cachedConfig = previous
    throw error
  }
}

type ModelAliasSpec = {
  target: string
  allowOriginal?: boolean
}

type ModelAliasMap = Record<string, string>

type ModelAliasInfoMap = Record<string, ModelAliasSpec>

type ModelAliasRawMap = Record<string, unknown>

function normalizeAliasKey(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeAliasTarget(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeAliasSpec(value: unknown): ModelAliasSpec | null {
  if (typeof value === "string") {
    const normalizedTarget = normalizeAliasTarget(value)
    return normalizedTarget ? { target: normalizedTarget } : null
  }
  if (!value || typeof value !== "object") {
    return null
  }

  const targetValue = (value as { target?: unknown }).target
  if (typeof targetValue !== "string") {
    return null
  }

  const normalizedTarget = normalizeAliasTarget(targetValue)
  if (!normalizedTarget) {
    return null
  }

  const allowOriginalValue = (value as { allowOriginal?: unknown })
    .allowOriginal
  const allowOriginal =
    typeof allowOriginalValue === "boolean" ? allowOriginalValue : undefined
  return { target: normalizedTarget, allowOriginal }
}

export function getModelAliasesInfo(): ModelAliasInfoMap {
  const config = getConfig()
  const raw = (config.modelAliases ?? {}) as ModelAliasRawMap
  const normalized: ModelAliasInfoMap = {}

  for (const [alias, rawSpec] of Object.entries(raw)) {
    const normalizedAlias = normalizeAliasKey(alias)
    const normalizedSpec = normalizeAliasSpec(rawSpec)
    if (!normalizedAlias || !normalizedSpec) {
      continue
    }
    if (!Object.hasOwn(normalized, normalizedAlias)) {
      normalized[normalizedAlias] = normalizedSpec
    }
  }

  return normalized
}

export function getModelAliases(): ModelAliasMap {
  const info = getModelAliasesInfo()
  const normalized: ModelAliasMap = {}

  for (const [alias, spec] of Object.entries(info)) {
    normalized[alias] = spec.target
  }

  return normalized
}

export function resolveModelAlias(modelId: string): string {
  const normalized = normalizeAliasKey(modelId)
  if (!normalized) return modelId
  const aliases = getModelAliases()
  return aliases[normalized] ?? modelId
}

export function isOriginalModelNameAllowedForAliases(): boolean {
  const config = getConfig()
  return config.allowOriginalModelNamesForAliases ?? false
}

export function getAliasTargetSet(): Set<string> {
  const aliases = getModelAliasesInfo()
  const allowOriginalDefault = isOriginalModelNameAllowedForAliases()
  const targetAllowMap = new Map<string, boolean>()

  for (const { target, allowOriginal } of Object.values(aliases)) {
    const normalizedTarget = target.toLowerCase()
    const effectiveAllow = allowOriginal ?? allowOriginalDefault
    const currentAllow = targetAllowMap.get(normalizedTarget)
    if (currentAllow === true) {
      continue
    }
    if (effectiveAllow) {
      targetAllowMap.set(normalizedTarget, true)
    } else if (currentAllow === undefined) {
      targetAllowMap.set(normalizedTarget, false)
    }
  }

  const blockedTargets = new Set<string>()
  for (const [target, allowed] of targetAllowMap.entries()) {
    if (!allowed) {
      blockedTargets.add(target)
    }
  }

  return blockedTargets
}

export function isOriginalModelNameAllowedForTarget(modelId: string): boolean {
  const normalized = normalizeAliasKey(modelId)
  if (!normalized) return true
  const blockedTargets = getAliasTargetSet()
  return !blockedTargets.has(normalized)
}

export function getPreferredAliasForTarget(modelId: string): string | null {
  const aliases = getModelAliases()
  const aliasKeys = getAliasKeysForTarget(modelId, aliases)
  return aliasKeys[0] ?? null
}

function getAliasKeysForTarget(
  target: string,
  aliases: ModelAliasMap,
): Array<string> {
  const normalizedTarget = target.toLowerCase()
  return Object.entries(aliases)
    .filter(([, model]) => model.toLowerCase() === normalizedTarget)
    .map(([alias]) => alias)
    .sort()
}

function getAliasFallbackValue<T extends string>(
  record: Record<string, T> | undefined,
  modelId: string,
  aliases: ModelAliasMap,
): T | undefined {
  if (!record) return undefined

  const aliasKeys = getAliasKeysForTarget(modelId, aliases)
  if (aliasKeys.length === 0) return undefined

  const recordByAlias = new Map<string, T>()
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeAliasKey(key)
    if (normalized) {
      recordByAlias.set(normalized, value)
    }
  }

  for (const alias of aliasKeys) {
    const value = recordByAlias.get(alias)
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

function getRecordValueForModel<T extends string>(
  record: Record<string, T> | undefined,
  modelId: string,
): T | undefined {
  if (!record) return undefined

  const direct = record[modelId]
  if (direct !== undefined) return direct

  const normalizedModel = normalizeAliasKey(modelId)
  if (!normalizedModel) return undefined

  for (const [key, value] of Object.entries(record)) {
    if (normalizeAliasKey(key) === normalizedModel) {
      return value
    }
  }

  return undefined
}

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  const direct = config.extraPrompts?.[model]
  if (direct !== undefined) return direct

  const aliases = getModelAliases()
  const fallback = getAliasFallbackValue(config.extraPrompts, model, aliases)
  if (fallback !== undefined) return fallback

  const normalizedModel = normalizeAliasKey(model)
  const aliasTarget = normalizedModel ? aliases[normalizedModel] : undefined
  if (aliasTarget && isGpt53OrAbove(aliasTarget)) {
    return gpt5CommentaryPrompt
  }

  return isGpt53OrAbove(model) ? gpt5CommentaryPrompt : ""
}

export function getModelMappings(): Record<string, string> {
  const config = getConfig()
  const modelMappings = config.modelMappings
  if (!modelMappings) {
    return { ...defaultConfig.modelMappings }
  }

  const validMappings: Record<string, string> = {}
  for (const [sourceModel, targetModel] of Object.entries(modelMappings)) {
    if (
      !sourceModel
      || typeof targetModel !== "string"
      || targetModel.length === 0
    ) {
      continue
    }
    validMappings[sourceModel] = targetModel
  }

  return validMappings
}

function validateModelMappings(
  modelMappings: Record<string, string>,
): Record<string, string> {
  const validatedMappings: Record<string, string> = {}
  for (const [sourceModel, targetModel] of Object.entries(modelMappings)) {
    if (!sourceModel || !targetModel) {
      throw new Error(
        "Each model mapping must use non-empty source and target values.",
      )
    }
    validatedMappings[sourceModel] = targetModel
  }

  return validatedMappings
}

export function setModelMappings(
  modelMappings: Record<string, string>,
): Record<string, string> {
  const nextConfig = {
    ...readConfigFromDisk(),
    modelMappings: validateModelMappings(modelMappings),
  }

  writeConfigToDisk(nextConfig)
  cachedConfig = reloadConfig()
  return getModelMappings()
}

export function resolveMappedModel(model: string): string {
  return getModelMappings()[model] ?? model
}

export function getSmallModelForProvider(provider: string): string | undefined {
  const name = provider.trim()
  const config = getConfig()
  const configured = config.smallModels
  const model =
    configured && Object.hasOwn(configured, name) ? configured[name]
    : name === "copilot" && config.smallModel !== undefined ? config.smallModel
    : defaultConfig.smallModels?.[name]
  if (typeof model !== "string" || !model.trim()) return undefined
  const value = model.trim()
  if (name !== "copilot" || isOriginalModelNameAllowedForTarget(value))
    return value
  return getPreferredAliasForTarget(value) ?? value
}

export function getSmallModel(): string {
  const model = getSmallModelForProvider("copilot") ?? "gpt-6-luna"
  if (isOriginalModelNameAllowedForTarget(model)) {
    return model
  }

  return getPreferredAliasForTarget(model) ?? model
}

export function getLogLevel(): LogLevel {
  const config = getConfig()
  const normalized = normalizeLogLevel(config.logLevel)
  return normalized ?? defaultConfig.logLevel ?? "info"
}

export function isAccountAffinityEnabled(): boolean {
  const config = getConfig()
  return config.accountAffinity ?? true
}

export function getModelRefreshIntervalHours(): number {
  const config = getConfig()
  const normalized = normalizeNonNegativeNumber(
    config.modelRefreshIntervalHours,
  )
  return normalized ?? defaultConfig.modelRefreshIntervalHours ?? 24
}

export function getModelRefreshIntervalMs(): number {
  const hours = getModelRefreshIntervalHours()
  if (!Number.isFinite(hours) || hours <= 0) return 0
  return hours * 60 * 60 * 1000
}

export function getQuotaRefreshConfig(): ResolvedQuotaRefreshConfig {
  return normalizeQuotaRefreshConfig(getConfig().quotaRefresh)
}

export function getSessionAffinityRetentionDays(): number {
  const config = getConfig()
  const normalized = normalizeNonNegativeNumber(
    config.sessionAffinityRetentionDays,
  )
  return normalized ?? defaultConfig.sessionAffinityRetentionDays ?? 7
}

export function getSessionAffinityRetentionMs(): number {
  const days = getSessionAffinityRetentionDays()
  if (!Number.isFinite(days) || days <= 0) return 0
  return days * 24 * 60 * 60 * 1000
}

export function isMessageStartInputTokensFallbackEnabled(): boolean {
  const config = getConfig()
  return config.messageStartInputTokensFallback ?? false
}

export function shouldCompactUseSmallModel(): boolean {
  const config = getConfig()
  return config.compactUseSmallModel ?? true
}

export function isContextManagementEnabledForMessages(): boolean {
  const config = getConfig()
  return config.contextManagement?.messages ?? defaultContextManagement.messages
}

export function isContextManagementEnabledForResponses(): boolean {
  const config = getConfig()
  return (
    config.contextManagement?.responses ?? defaultContextManagement.responses
  )
}

/** @deprecated use endpoint-specific context management helpers */
export function isResponsesApiContextManagementEnabled(): boolean {
  return isContextManagementEnabledForMessages()
}

export function getModelResponsesApiCompactThreshold(
  model: string,
): number | undefined {
  const config = getConfig()
  const threshold = config.modelResponsesApiCompactThresholds?.[model]

  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) {
    return undefined
  }

  return threshold
}

export function getConfiguredReasoningEffortForModel(
  model: string,
): ConfiguredReasoningEffort | undefined {
  const config = getConfig()
  const efforts = config.modelReasoningEfforts
  const direct = getReasoningEffortRecordValue(efforts, model)
  if (direct !== undefined) return direct

  const aliases = getModelAliases()
  const normalizedModel = normalizeAliasKey(model)
  const aliasTarget = normalizedModel ? aliases[normalizedModel] : undefined
  if (aliasTarget) {
    const targetDirect = getReasoningEffortRecordValue(efforts, aliasTarget)
    if (targetDirect !== undefined) return targetDirect
  }

  const aliasFallback = getAliasFallbackValue(efforts, model, aliases)
  if (aliasFallback !== undefined) return aliasFallback

  if (aliasTarget && isGpt53OrAbove(aliasTarget)) return "xhigh"

  return isGpt53OrAbove(model) ? "xhigh" : undefined
}

function getReasoningEffortRecordValue(
  record: Record<string, ConfiguredReasoningEffort> | undefined,
  modelId: string,
): ConfiguredReasoningEffort | undefined {
  const direct = getRecordValueForModel(record, modelId)
  if (direct !== undefined) return direct

  const normalizedModel = normalizeAliasKey(modelId)
  if (normalizedModel?.startsWith("gpt-5-mini-")) {
    return getRecordValueForModel(record, "gpt-5-mini")
  }

  return undefined
}

export function isForceAgentEnabled(): boolean {
  const config = getConfig()
  return config.forceAgent ?? false
}

export function normalizeProviderBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "")
}

function normalizePricingCurrency(
  value: string | undefined,
): string | undefined {
  const currency = value?.trim().toUpperCase()
  return currency || undefined
}

function getDefaultProviderAuthType(
  providerType: ProviderType,
): ProviderAuthType {
  return providerType === "anthropic" ? "x-api-key" : "authorization"
}

export function resolveProviderAuthType(
  providerName: string,
  authType: string | undefined,
  providerType: ProviderType,
): ProviderAuthType {
  const defaultAuthType = getDefaultProviderAuthType(providerType)
  if (authType === undefined) {
    return defaultAuthType
  }

  if (authType === "x-api-key") {
    return "x-api-key"
  }

  if (authType === "oauth2") {
    if (providerName === "codex") {
      return authType
    }

    consola.warn(
      `Provider ${providerName} has authType 'oauth2', which is only supported by the builtin codex provider, falling back to ${defaultAuthType}`,
    )
    return defaultAuthType
  }

  if (authType === "authorization" || authType === "azure-entra") {
    return authType
  }

  consola.warn(
    `Provider ${providerName} has invalid authType '${authType}', falling back to ${defaultAuthType}`,
  )
  return defaultAuthType
}

function isProviderApiKeyRequired(
  providerName: string,
  authType: ProviderAuthType,
): boolean {
  return (
    authType !== "azure-entra"
    && !(providerName === "codex" && authType === "oauth2")
  )
}

export function getRawProviderConfig(name: string): ProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  const config = getConfig()
  return config.providers?.[providerName] ?? null
}

export function setProviderConfig(
  name: string,
  provider: ProviderConfig,
): ProviderConfig {
  const providerName = name.trim()
  if (!providerName) {
    throw new Error("Provider name must be a non-empty string")
  }

  if (isReservedProviderName(providerName)) {
    throw new Error(
      `Provider ${providerName} is reserved and cannot be configured in config.providers`,
    )
  }

  const editableConfig = readConfigFromDisk()
  const nextConfig = {
    ...editableConfig,
    providers: {
      ...editableConfig.providers,
      [providerName]: provider,
    },
  }

  writeConfigToDisk(nextConfig)
  cachedConfig = reloadConfig()
  return getRawProviderConfig(providerName) ?? provider
}

export function getProviderConfig(name: string): ResolvedProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  if (isReservedProviderName(providerName)) {
    consola.warn(
      `Provider ${providerName} is reserved and cannot be configured in config.providers`,
    )
    return null
  }

  const provider = getRawProviderConfig(providerName)
  if (!provider) {
    return null
  }

  if (provider.enabled === false) {
    return null
  }

  const type = provider.type ?? PROVIDER_TYPE_ANTHROPIC
  if (!isSupportedProviderType(type)) {
    consola.warn(
      `Provider ${providerName} is ignored because type '${type}' is not supported`,
    )
    return null
  }

  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl ?? "")
  const authType = resolveProviderAuthType(
    providerName,
    provider.authType,
    type,
  )
  const apiKey = (provider.apiKey ?? "").trim()
  const missingFields = [
    ...(baseUrl ? [] : ["baseUrl"]),
    ...(isProviderApiKeyRequired(providerName, authType) && !apiKey ?
      ["apiKey"]
    : []),
  ]

  if (missingFields.length > 0) {
    consola.warn(
      `Provider ${providerName} is enabled but missing ${missingFields.join(" or ")}`,
    )
    return null
  }

  return {
    name: providerName,
    type,
    baseUrl,
    modelsDevProviderId: provider.modelsDevProviderId,
    codexModels: provider.codexModels,
    apiKey,
    authType,
    authTypeExplicit: provider.authType !== undefined,
    pricingCurrency: normalizePricingCurrency(provider.pricingCurrency),
    models: provider.models,
    adjustInputTokens: provider.adjustInputTokens,
  }
}

export function resolveEffectiveProviderType(
  providerConfig: ResolvedProviderConfig,
  model: string,
): ProviderType {
  const modelConfig = providerConfig.models?.[model]
  if (modelConfig?.type && isSupportedProviderType(modelConfig.type)) {
    return modelConfig.type
  }

  if (providerConfig.name === "opencode-go") {
    return getOpencodeGoModelProviderType(model)
  }

  if (providerConfig.modelsDevProviderId) {
    const catalogType = getModelsDevModelProviderType(
      providerConfig.modelsDevProviderId,
      model,
    )
    if (catalogType) return catalogType
  }

  if (providerConfig.name === "openrouter") {
    if (model.includes("gpt-")) {
      return "openai-responses"
    }
  }

  return providerConfig.type
}

export function resolveProviderConfigForModel(
  providerConfig: ResolvedProviderConfig,
  model: string,
): ResolvedProviderConfig {
  const type = resolveEffectiveProviderType(providerConfig, model)
  const modelApi =
    (
      providerConfig.modelsDevProviderId
      && providerConfig.baseUrl
        === getModelsDevProviderApi(providerConfig.modelsDevProviderId)
    ) ?
      getModelsDevModelApi(providerConfig.modelsDevProviderId, model)
    : undefined
  const configuredModel = providerConfig.models?.[model]
  const catalogPricing =
    providerConfig.modelsDevProviderId ?
      getModelsDevModelPricing(providerConfig.modelsDevProviderId, model)
    : undefined
  const useCatalogPricing =
    catalogPricing !== undefined && configuredModel?.pricing === undefined
  if (type === providerConfig.type && !modelApi && !useCatalogPricing) {
    return providerConfig
  }

  return {
    ...providerConfig,
    type,
    baseUrl: modelApi ?? providerConfig.baseUrl,
    models:
      useCatalogPricing ?
        {
          ...providerConfig.models,
          [model]: { ...configuredModel, pricing: catalogPricing },
        }
      : providerConfig.models,
    pricingCurrency: useCatalogPricing ? "USD" : providerConfig.pricingCurrency,
    authType:
      (
        type !== providerConfig.type
        && !providerConfig.authTypeExplicit
        && providerConfig.authType !== "azure-entra"
        && providerConfig.authType !== "oauth2"
      ) ?
        resolveProviderAuthType(providerConfig.name, undefined, type)
      : providerConfig.authType,
  }
}

export const resolveEffectiveProviderConfig = resolveProviderConfigForModel

export function listEnabledProviders(): Array<string> {
  const config = getConfig()
  const providerNames = Object.keys(config.providers ?? {})
  return providerNames.filter(
    (name) => !isReservedProviderName(name) && getProviderConfig(name) !== null,
  )
}

export function isReservedProviderName(name: string): boolean {
  return name.trim() === "copilot" || name.trim() === "github-copilot"
}

export function isMessagesApiEnabled(): boolean {
  const config = getConfig()
  return config.useMessagesApi ?? true
}

export function isResponsesApiWebSocketEnabled(): boolean {
  const config = getConfig()
  return config.useResponsesApiWebSocket ?? true
}

export function getAnthropicApiKey(): string | undefined {
  const config = getConfig()
  return config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? undefined
}

export function isResponsesApiWebSearchEnabled(): boolean {
  const config = getConfig()
  return config.useResponsesApiWebSearch ?? true
}

export function isAlphaSearchCodexPriorityEnabled(): boolean {
  const config = getConfig()
  return config.alphaSearchCodexPriority ?? true
}

export function getAlphaSearchModel(): string | undefined {
  const model = getConfig().alphaSearchModel ?? "gpt-6-luna"
  return model.trim() || undefined
}

export function getMessageApiWebSearchModel(): string | undefined {
  const config = getConfig()
  const model = config.messageApiWebSearchModel?.trim()
  return model && model.length > 0 ? model : undefined
}

export function getClaudeAutoModel(): string | undefined {
  const config = getConfig()
  const model = config.claudeAutoModel
  return model && model.trim().length > 0 ? model.trim() : undefined
}

export function getClaudeTokenMultiplier(): number {
  const config = getConfig()
  return config.claudeTokenMultiplier ?? 1.15
}

export function isCopilotUseLocalModelsEnabled(): boolean {
  const config = getConfig()
  return config.copilotUseLocalModels ?? false
}

// responsesTransport was renamed to upstreamTransport, and headersTimeoutMsV2
// to headersTimeoutMs, when this block started applying to every upstream HTTP
// transport. Legacy configs are migrated once during the startup merge and the
// old keys are dropped from disk.
interface LegacyAppConfig extends AppConfig {
  responsesTransport?: LegacyUpstreamTransportConfig
}

interface LegacyUpstreamTransportConfig extends UpstreamTransportConfig {
  headersTimeoutMsV2?: number
}

const migrateUpstreamTransportConfig = (
  config: AppConfig,
): { changed: boolean; migrated: UpstreamTransportConfig } => {
  const legacyBlock = (config as LegacyAppConfig).responsesTransport
  const { headersTimeoutMsV2, ...migrated } = (config.upstreamTransport
    ?? legacyBlock
    ?? {}) as LegacyUpstreamTransportConfig

  const hasLegacyBlock = legacyBlock !== undefined
  const hasLegacyHeadersTimeout = headersTimeoutMsV2 !== undefined
  if (!hasLegacyBlock && !hasLegacyHeadersTimeout) {
    return { changed: false, migrated }
  }

  consola.info(
    "Migrating deprecated transport config: responsesTransport -> upstreamTransport, headersTimeoutMsV2 -> headersTimeoutMs",
  )

  return {
    changed: true,
    migrated:
      migrated.headersTimeoutMs === undefined && hasLegacyHeadersTimeout ?
        { ...migrated, headersTimeoutMs: headersTimeoutMsV2 }
      : migrated,
  }
}

export function getUpstreamTransportConfig(): Required<UpstreamTransportConfig> {
  return normalizeUpstreamTransportConfig(getConfig().upstreamTransport)
}

export const normalizeUpstreamTransportConfig = (
  configured: UpstreamTransportConfig | undefined,
): Required<UpstreamTransportConfig> => ({
  headersTimeoutMs: positiveIntegerOrDefault(
    configured?.headersTimeoutMs,
    defaultUpstreamTransportConfig.headersTimeoutMs,
  ),
  streamInactivityTimeoutMs: positiveIntegerOrDefault(
    configured?.streamInactivityTimeoutMs,
    defaultUpstreamTransportConfig.streamInactivityTimeoutMs,
  ),
  websocketMaxBufferedBytes: positiveIntegerOrDefault(
    configured?.websocketMaxBufferedBytes,
    defaultUpstreamTransportConfig.websocketMaxBufferedBytes,
  ),
  websocketMaxBufferedMessages: positiveIntegerOrDefault(
    configured?.websocketMaxBufferedMessages,
    defaultUpstreamTransportConfig.websocketMaxBufferedMessages,
  ),
  websocketOpenTimeoutMs: positiveIntegerOrDefault(
    configured?.websocketOpenTimeoutMs,
    defaultUpstreamTransportConfig.websocketOpenTimeoutMs,
  ),
  websocketPoolIdleTimeoutMs: positiveIntegerOrDefault(
    configured?.websocketPoolIdleTimeoutMs,
    defaultUpstreamTransportConfig.websocketPoolIdleTimeoutMs,
  ),
})

const positiveIntegerOrDefault = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback

  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : fallback
}

function mergeDefaultTransportConfig(config: AppConfig): ConfigMergeResult {
  const result = migrateUpstreamTransportConfig(config)
  const upstreamTransport = normalizeUpstreamTransportConfig(result.migrated)
  const changed =
    result.changed
    || JSON.stringify(config.upstreamTransport)
      !== JSON.stringify(upstreamTransport)
  const { responsesTransport: _legacy, ...current } = config as LegacyAppConfig
  return {
    mergedConfig: changed ? { ...current, upstreamTransport } : config,
    changed,
  }
}
