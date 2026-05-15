import consola from "consola"
import fs from "node:fs"

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

export interface AppConfig {
  auth?: {
    apiKeys?: Array<string>
  }
  providers?: Record<string, ProviderConfig>
  extraPrompts?: Record<string, string>
  smallModel?: string
  accountAffinity?: boolean
  /** @deprecated */
  apiKey?: string
  responsesApiContextManagementModels?: Array<string>
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >
  modelAliases?: Record<string, { target: string; allowOriginal?: boolean }>
  allowOriginalModelNamesForAliases?: boolean
  useFunctionApplyPatch?: boolean
  forceAgent?: boolean
  compactUseSmallModel?: boolean
  messageStartInputTokensFallback?: boolean
  modelRefreshIntervalHours?: number
  sessionAffinityRetentionDays?: number
  useMessagesApi?: boolean
  useResponsesApiWebSocket?: boolean
  anthropicApiKey?: string
  useResponsesApiWebSearch?: boolean
  claudeTokenMultiplier?: number
  logLevel?: LogLevel
  devMode?: DevModeConfig
  quotaRefresh?: QuotaRefreshConfig
}

export interface ModelConfig {
  temperature?: number
  topP?: number
  topK?: number
  extraBody?: Record<string, unknown>
  contextCache?: boolean
  supportPdf?: boolean
  toolContentSupportType?: Array<ToolContentSupportType>
}

export const PROVIDER_TYPE_ANTHROPIC = "anthropic" as const

export type ProviderType = "anthropic" | "openai-compatible"
export type ProviderAuthType = "authorization" | "x-api-key"
export type ToolContentSupportType = "array" | "image" | "pdf"

export interface ProviderConfig {
  type?: string
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  authType?: ProviderAuthType
  models?: Record<string, ModelConfig>
  adjustInputTokens?: boolean
}

export interface ResolvedProviderConfig {
  name: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  authType: ProviderAuthType
  models?: Record<string, ModelConfig>
  adjustInputTokens?: boolean
}

const gpt5ExplorationPrompt = `## Exploration and reading files
- **Think first.** Before any tool call, decide ALL files/resources you will need.
- **Batch everything.** If you need multiple files (even from different places), read them together.
- **multi_tool_use.parallel** Use multi_tool_use.parallel to parallelize tool calls and only this.
- **Only make sequential calls if you truly cannot know the next file without seeing a result first.**
- **Workflow:** (a) plan all needed reads → (b) issue one parallel batch → (c) analyze results → (d) repeat if new, unpredictable reads arise.`

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

const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  providers: {},
  extraPrompts: {
    "gpt-5-mini": gpt5ExplorationPrompt,
    "gpt-5.3-codex": gpt5CommentaryPrompt,
    "gpt-5.4-mini": gpt5CommentaryPrompt,
    "gpt-5.4": gpt5CommentaryPrompt,
    "gpt-5.5": gpt5CommentaryPrompt,
  },
  smallModel: "gpt-5-mini",
  accountAffinity: true,
  responsesApiContextManagementModels: [],
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4-mini": "xhigh",
    "gpt-5.4": "xhigh",
    "gpt-5.5": "xhigh",
  },
  allowOriginalModelNamesForAliases: false,
  useFunctionApplyPatch: true,
  forceAgent: false,
  compactUseSmallModel: true,
  messageStartInputTokensFallback: false,
  modelRefreshIntervalHours: 24,
  sessionAffinityRetentionDays: 7,
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  useResponsesApiWebSearch: true,
  logLevel: "info",
  devMode: {
    enabled: false,
    capture4xx: false,
    capture5xx: false,
    captureOther: false,
  },
  quotaRefresh: DEFAULT_QUOTA_REFRESH_CONFIG,
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

function ensureConfigFile(): void {
  try {
    fs.accessSync(PATHS.CONFIG_PATH, fs.constants.R_OK)
    return
  } catch {
    // Fall through to try creating the default config file.
  }

  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
      "utf8",
    )
    try {
      fs.chmodSync(PATHS.CONFIG_PATH, 0o600)
    } catch {
      // Ignore chmod errors (e.g. unsupported filesystem).
    }
  } catch {
    // Best-effort only: if we can't create the file, reads will fall back to defaults.
  }
}

function readConfigFromDisk(): AppConfig {
  ensureConfigFile()
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      )
      return defaultConfig
    }
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    consola.error("Failed to read config file, using default config", error)
    return defaultConfig
  }
}

function mergeDefaultConfig(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const extraPrompts = config.extraPrompts ?? {}
  const defaultExtraPrompts = defaultConfig.extraPrompts ?? {}
  const modelReasoningEfforts = config.modelReasoningEfforts ?? {}
  const defaultModelReasoningEfforts = defaultConfig.modelReasoningEfforts ?? {}
  const hasForceAgent = typeof config.forceAgent === "boolean"
  const defaultForceAgent = defaultConfig.forceAgent ?? false

  const missingExtraPromptModels = Object.keys(defaultExtraPrompts).filter(
    (model) => !Object.hasOwn(extraPrompts, model),
  )

  const missingReasoningEffortModels = Object.keys(
    defaultModelReasoningEfforts,
  ).filter((model) => !Object.hasOwn(modelReasoningEfforts, model))

  const hasExtraPromptChanges = missingExtraPromptModels.length > 0
  const hasReasoningEffortChanges = missingReasoningEffortModels.length > 0
  const hasForceAgentChanges = !hasForceAgent

  if (
    !hasExtraPromptChanges
    && !hasReasoningEffortChanges
    && !hasForceAgentChanges
  ) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      extraPrompts: {
        ...defaultExtraPrompts,
        ...extraPrompts,
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

function mergeDefaultAuth(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const authConfig = isPlainObject(config.auth) ? config.auth : undefined
  const rawApiKeys =
    Array.isArray(authConfig?.apiKeys) ? authConfig.apiKeys : undefined
  const normalizedApiKeys = normalizeAuthApiKeys(rawApiKeys)
  const nextAuth = { apiKeys: normalizedApiKeys }

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
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(mergedConfig, null, 2)}\n`,
        "utf8",
      )
    } catch (writeError) {
      consola.warn("Failed to write merged config defaults", writeError)
    }
  }

  cachedConfig = mergedConfig
  return mergedConfig
}

export function getConfig(): AppConfig {
  cachedConfig ??= mergeDefaultConfig(readConfigFromDisk()).mergedConfig
  return cachedConfig
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

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  const direct = config.extraPrompts?.[model]
  if (direct !== undefined) return direct

  const aliases = getModelAliases()
  const fallback = getAliasFallbackValue(config.extraPrompts, model, aliases)
  return fallback ?? ""
}

export function getSmallModel(): string {
  const config = getConfig()
  const model = config.smallModel ?? "gpt-5-mini"
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

export function getResponsesApiContextManagementModels(): Array<string> {
  const config = getConfig()
  return (
    config.responsesApiContextManagementModels
    ?? defaultConfig.responsesApiContextManagementModels
    ?? []
  )
}

export function isResponsesApiContextManagementModel(model: string): boolean {
  return getResponsesApiContextManagementModels().includes(model)
}

export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const config = getConfig()
  const direct = config.modelReasoningEfforts?.[model]
  if (direct !== undefined) return direct

  const aliases = getModelAliases()
  const fallback = getAliasFallbackValue(
    config.modelReasoningEfforts,
    model,
    aliases,
  )
  return fallback ?? "high"
}

export function isForceAgentEnabled(): boolean {
  const config = getConfig()
  return config.forceAgent ?? false
}

export function normalizeProviderBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "")
}

function getDefaultProviderAuthType(
  providerType: ProviderType,
): ProviderAuthType {
  return providerType === "openai-compatible" ? "authorization" : "x-api-key"
}

export function resolveProviderAuthType(
  providerName: string,
  authType: string | undefined,
  providerType: ProviderType,
): ProviderAuthType {
  if (authType === undefined) {
    return getDefaultProviderAuthType(providerType)
  }

  if (authType === "x-api-key") {
    return "x-api-key"
  }

  if (authType === "authorization") {
    return authType
  }

  consola.warn(
    `Provider ${providerName} has invalid authType '${authType}', falling back to ${getDefaultProviderAuthType(providerType)}`,
  )
  return getDefaultProviderAuthType(providerType)
}

export function getProviderConfig(name: string): ResolvedProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  const config = getConfig()
  const provider = config.providers?.[providerName]
  if (!provider) {
    return null
  }

  if (provider.enabled === false) {
    return null
  }

  const type = provider.type ?? PROVIDER_TYPE_ANTHROPIC
  if (type !== PROVIDER_TYPE_ANTHROPIC && type !== "openai-compatible") {
    consola.warn(
      `Provider ${providerName} is ignored because type '${type}' is not supported`,
    )
    return null
  }

  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl ?? "")
  const apiKey = (provider.apiKey ?? "").trim()
  const authType = resolveProviderAuthType(
    providerName,
    provider.authType,
    type,
  )
  if (!baseUrl || !apiKey) {
    consola.warn(
      `Provider ${providerName} is enabled but missing baseUrl or apiKey`,
    )
    return null
  }

  return {
    name: providerName,
    type,
    baseUrl,
    apiKey,
    authType,
    models: provider.models,
    adjustInputTokens: provider.adjustInputTokens,
  }
}

export function listEnabledProviders(): Array<string> {
  const config = getConfig()
  const providerNames = Object.keys(config.providers ?? {})
  return providerNames.filter((name) => getProviderConfig(name) !== null)
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

export function getClaudeTokenMultiplier(): number {
  const config = getConfig()
  return config.claudeTokenMultiplier ?? 1.15
}
