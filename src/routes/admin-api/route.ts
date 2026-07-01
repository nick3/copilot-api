/* eslint-disable max-lines */
import { Hono, type Context } from "hono"

import {
  DEFAULT_IDENTITY_ENTERPRISE_DOMAIN,
  getCurrentIdentityEnvironment,
} from "~/lib/account-client-identity"
import { accountsManager } from "~/lib/accounts-manager"
import {
  getAccountClientIdentityByLoginAndApp,
  listAccountsFromRegistry,
  loadRegistry,
  removeAccountFromRegistry,
  removeAccountToken,
  saveRegistry,
} from "~/lib/accounts-registry"
import {
  getConfig,
  getModelAliases,
  getModelAliasesInfo,
  getModelRefreshIntervalMs,
  isAccountAffinityEnabled,
  isSupportedProviderType,
  mergeConfigWithDefaults,
  SUPPORTED_PROVIDER_TYPES,
  type AppConfig,
  type DevModeConfig,
  type LogLevel,
  type ModelConfig,
  type ProviderConfig,
  type QuotaRefreshConfig,
  type TokenUsagePricingConfig,
  type TokenUsagePricingTier,
  type ToolContentSupportType,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { updateQuotaRefreshSchedulerFromConfig } from "~/lib/quota-refresh-scheduler-runtime"
import {
  parseReasoningEffortSupport,
  REASONING_EFFORTS as REASONING_EFFORT_VALUES,
  type ReasoningEffort,
} from "~/lib/reasoning-effort"
import {
  getRequestHistoryStore,
  getStatsStore,
  toAdminRequestLogRow,
  type AccountStatsRow,
} from "~/lib/request-history"
import { getRequestOutboundStore } from "~/lib/request-outbound"
import { applySharedSessionAffinityRetention } from "~/lib/session-affinity-store"
import { toLocalDateString } from "~/lib/stats-store"
import {
  getTokenUsageDailySummary,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
  type TokenUsagePeriod,
} from "~/lib/token-usage"
import { isAccountType } from "~/lib/types/account"

import { getAggregatedModelsResponse } from "../models/route"
import { authSessionManager } from "./auth-sessions"
import { writeConfigFile } from "./config-writer"
import { replayRoutes } from "./replay"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || undefined

type AdminAccessDecision =
  | { ok: true }
  | {
      ok: false
      status: 401 | 403
      message: string
      errorType: "unauthorized" | "forbidden"
    }

type AdminAccessRequest = {
  req: {
    url: string
    header(name: string): string | undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  )
}

function getBearerToken(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined
  const token = trimmed.slice("bearer ".length).trim()
  return token || undefined
}

function getRequestAdminToken(c: AdminAccessRequest): string | undefined {
  const headerToken = c.req.header("x-admin-token")?.trim()
  if (headerToken) return headerToken

  const bearer = c.req.header("authorization")
  if (bearer) {
    return getBearerToken(bearer)
  }

  return undefined
}

function isSameOrigin(requestUrl: URL, originHeader: string): boolean {
  try {
    return new URL(originHeader).origin === requestUrl.origin
  } catch {
    return false
  }
}

function decideAdminAccess(c: AdminAccessRequest): AdminAccessDecision {
  const url = new URL(c.req.url, "http://local")

  const token = getRequestAdminToken(c)
  const tokenOk = Boolean(ADMIN_TOKEN) && token === ADMIN_TOKEN

  const origin = c.req.header("origin")
  if (origin && !tokenOk && !isSameOrigin(url, origin)) {
    return {
      ok: false,
      status: 403,
      message: "Cross-origin access to admin API is forbidden.",
      errorType: "forbidden",
    }
  }

  if (isLoopbackHostname(url.hostname) || tokenOk) {
    return { ok: true }
  }

  if (ADMIN_TOKEN) {
    return {
      ok: false,
      status: 401,
      message:
        "Admin API requires x-admin-token or Authorization: Bearer <token>.",
      errorType: "unauthorized",
    }
  }

  return {
    ok: false,
    status: 403,
    message:
      "Admin API is only available on localhost. Set ADMIN_TOKEN to enable remote access.",
    errorType: "forbidden",
  }
}

type AccountItem = {
  account_id: string
  account_type?: string
  runtime: {
    entitlement?: number
    remaining?: number
    unlimited?: boolean
    creditsEntitlement?: number
    creditsRemaining?: number
    creditsUnlimited?: boolean
    overagePermitted?: boolean
    tokenBasedBilling?: boolean
    failed?: boolean
    failureReason?: string
    enabled?: boolean
    lastModelsFetch?: number
    isRefreshingModels?: boolean
  }
  stats?: {
    since_ms: number
    request_count?: number
    error_count?: number
    tokens_total?: number
    avg_duration_ms?: number
    last_request_at_ms?: number
  }
}

function parseFiniteNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function parseTriStateBool(value: string | null): boolean | undefined {
  if (value === "1") return true
  if (value === "0") return false
  return undefined
}

const TOKEN_USAGE_PERIODS = new Set<TokenUsagePeriod>(["day", "week", "month"])
const DEFAULT_TOKEN_USAGE_EVENTS_PAGE_SIZE = 20

function parseTokenUsagePeriod(value: string | null): TokenUsagePeriod {
  return TOKEN_USAGE_PERIODS.has(value as TokenUsagePeriod) ?
      (value as TokenUsagePeriod)
    : "day"
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

type ConfigErrorType = "bad_request" | "internal_error" | "not_found"

type ConfigErrorPayload = {
  message: string
  type: ConfigErrorType
}

const CONFIG_KEYS = new Set<keyof AppConfig>([
  "auth",
  "extraPrompts",
  "smallModel",
  "logLevel",
  "accountAffinity",
  "apiKey",
  "anthropicApiKey",
  "providers",
  "responsesApiContextManagementModels",
  "modelReasoningEfforts",
  "modelResponsesApiCompactThresholds",
  "modelAliases",
  "modelMappings",
  "allowOriginalModelNamesForAliases",
  "forceAgent",
  "compactUseSmallModel",
  "messageStartInputTokensFallback",
  "modelRefreshIntervalHours",
  "sessionAffinityRetentionDays",
  "useMessagesApi",
  "useResponsesApiWebSocket",
  "useResponsesApiWebSearch",
  "messageApiWebSearchModel",
  "useResponsesApiContextManagement",
  "copilotUseLocalModels",
  "devMode",
  "quotaRefresh",
])

const REASONING_EFFORTS = new Set<ReasoningEffort>(REASONING_EFFORT_VALUES)

const LOG_LEVELS = new Set<LogLevel>(["error", "warn", "info", "debug"])

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"])

function jsonError(
  c: Context,
  status: 400 | 404 | 500,
  error: ConfigErrorPayload,
): Response {
  return c.json(
    {
      error,
    },
    status,
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type ParseFieldResult<T> = { clear: true } | { value: T } | { error: string }

type AuthConfig = NonNullable<AppConfig["auth"]>

function parseOptionalString(
  value: unknown,
  field: string,
): ParseFieldResult<string> {
  if (value === null || value === undefined) return { clear: true }
  if (typeof value !== "string") return { error: `${field} must be a string` }

  const trimmed = value.trim()
  if (!trimmed) return { clear: true }

  return { value: trimmed }
}

function parseOptionalLogLevel(value: unknown): ParseFieldResult<LogLevel> {
  const parsed = parseOptionalString(value, "logLevel")
  if ("error" in parsed) return parsed
  if ("clear" in parsed) return parsed

  if (!LOG_LEVELS.has(parsed.value as LogLevel)) {
    return {
      error: `logLevel must be one of: ${[...LOG_LEVELS].join(", ")}`,
    }
  }

  return { value: parsed.value as LogLevel }
}

function parseOptionalBoolean(
  value: unknown,
  field: string,
): ParseFieldResult<boolean> {
  if (value === null || value === undefined) return { clear: true }
  if (typeof value !== "boolean") return { error: `${field} must be a boolean` }
  return { value }
}

function parseOptionalNonNegativeNumber(
  value: unknown,
  field: string,
): ParseFieldResult<number> {
  if (value === null || value === undefined) return { clear: true }
  if (typeof value !== "number") return { error: `${field} must be a number` }
  if (!Number.isFinite(value) || value < 0) {
    return { error: `${field} must be a non-negative number` }
  }
  return { value }
}

function parseOptionalStringArray(
  value: unknown,
  field: string,
): ParseFieldResult<Array<string>> {
  if (value === null || value === undefined) return { clear: true }
  if (!Array.isArray(value)) {
    return { error: `${field} must be an array of strings` }
  }

  const out: Array<string> = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      return { error: `${field}[${index}] must be a string` }
    }
    const trimmed = entry.trim()
    if (!trimmed) {
      return { error: `${field}[${index}] must be a non-empty string` }
    }
    out.push(trimmed)
  }

  return { value: [...new Set(out)] }
}

function parseAuthConfig(value: unknown): ParseFieldResult<AuthConfig> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "auth must be an object" }
  }

  for (const key of Object.keys(value)) {
    if (key !== "apiKeys") {
      return { error: `auth.${key} is not supported` }
    }
  }

  if (
    !("apiKeys" in value)
    || value.apiKeys === null
    || value.apiKeys === undefined
  ) {
    return { value: { apiKeys: [] } }
  }

  if (!Array.isArray(value.apiKeys)) {
    return { error: "auth.apiKeys must be an array of strings" }
  }

  const normalizedApiKeys = value.apiKeys
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  if (normalizedApiKeys.length !== value.apiKeys.length) {
    return { error: "auth.apiKeys must contain non-empty strings only" }
  }

  return { value: { apiKeys: [...new Set(normalizedApiKeys)] } }
}

function parseStringRecord(
  value: unknown,
  field: string,
): ParseFieldResult<Record<string, string>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object with string values` }
  }

  const record = Object.create(null) as Record<string, string>
  for (const [key, entry] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) {
      return { error: `${field}.${key} is not allowed` }
    }
    if (typeof entry !== "string") {
      return { error: `${field}.${key} must be a string` }
    }
    record[key] = entry
  }

  return { value: record }
}

const PROVIDER_MODEL_CONFIG_FIELDS = [
  "temperature",
  "topP",
  "topK",
  "type",
  "extraBody",
  "contextCache",
  "pricing",
  "supportPdf",
  "toolContentSupportType",
] as const

type ProviderModelConfigField = (typeof PROVIDER_MODEL_CONFIG_FIELDS)[number]

const PROVIDER_MODEL_CONFIG_KEYS = new Set<ProviderModelConfigField>(
  PROVIDER_MODEL_CONFIG_FIELDS,
)

const TOOL_CONTENT_SUPPORT_TYPES = [
  "array",
  "image",
  "pdf",
] as const satisfies ReadonlyArray<ToolContentSupportType>

const TOOL_CONTENT_SUPPORT_TYPE_SET = new Set<ToolContentSupportType>(
  TOOL_CONTENT_SUPPORT_TYPES,
)

const TOKEN_USAGE_PRICING_NUMBER_FIELDS = [
  "cachedInput",
  "cacheCreationInput",
  "explicitCachedInput",
  "input",
  "maxInputTokens",
  "output",
] as const

const TOKEN_USAGE_PRICING_FIELDS = [
  ...TOKEN_USAGE_PRICING_NUMBER_FIELDS,
  "tiers",
] as const

const TOKEN_USAGE_PRICING_KEYS = new Set<string>(TOKEN_USAGE_PRICING_FIELDS)

const PROVIDER_CONFIG_FIELDS = [
  "type",
  "enabled",
  "baseUrl",
  "apiKey",
  "authType",
  "pricingCurrency",
  "models",
  "adjustInputTokens",
] as const

type ProviderConfigField = (typeof PROVIDER_CONFIG_FIELDS)[number]

type ProviderAuthTypeValue = NonNullable<ProviderConfig["authType"]>

const PROVIDER_AUTH_TYPES = ["authorization", "oauth2", "x-api-key"] as const

const PROVIDER_CONFIG_KEYS = new Set<ProviderConfigField>(
  PROVIDER_CONFIG_FIELDS,
)

function isProviderAuthType(value: string): value is ProviderAuthTypeValue {
  return PROVIDER_AUTH_TYPES.includes(value as ProviderAuthTypeValue)
}

function validateAllowedObjectKeys(
  value: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  for (const key of Object.keys(value)) {
    if (BLOCKED_KEYS.has(key)) {
      return `${field}.${key} is not allowed`
    }
    if (!allowed.has(key)) {
      return `${field}.${key} is not supported`
    }
  }
  return undefined
}

function applyProviderModelTemperature(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "temperature")) return undefined

  const parsed = parseOptionalNonNegativeNumber(
    value.temperature,
    `${field}.temperature`,
  )
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.temperature = parsed.value
  return undefined
}

function applyProviderModelTopP(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "topP")) return undefined

  const parsed = parseOptionalNonNegativeNumber(value.topP, `${field}.topP`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.topP = parsed.value
  return undefined
}

function applyProviderModelTopK(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "topK")) return undefined

  const parsed = parseOptionalNonNegativeNumber(value.topK, `${field}.topK`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.topK = parsed.value
  return undefined
}

function applyProviderModelType(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "type")) return undefined

  const parsed = parseOptionalString(value.type, `${field}.type`)
  if ("error" in parsed) return parsed.error
  if (!("value" in parsed)) return undefined

  const type = parsed.value.trim()
  if (!type) return undefined
  if (!isSupportedProviderType(type)) {
    return `${field}.type must be one of: ${SUPPORTED_PROVIDER_TYPES.join(", ")}`
  }

  config.type = type
  return undefined
}

function applyProviderModelContextCache(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "contextCache")) return undefined

  const parsed = parseOptionalBoolean(
    value.contextCache,
    `${field}.contextCache`,
  )
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.contextCache = parsed.value
  return undefined
}

function applyProviderModelSupportPdf(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "supportPdf")) return undefined

  const parsed = parseOptionalBoolean(value.supportPdf, `${field}.supportPdf`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.supportPdf = parsed.value
  return undefined
}

function applyProviderModelToolContentSupportType(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "toolContentSupportType")) return undefined

  const raw = value.toolContentSupportType
  if (raw === null || raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    return `${field}.toolContentSupportType must be an array`
  }

  const normalized: Array<ToolContentSupportType> = []
  const seen = new Set<ToolContentSupportType>()
  for (const [index, item] of raw.entries()) {
    if (
      typeof item !== "string"
      || !TOOL_CONTENT_SUPPORT_TYPE_SET.has(item as ToolContentSupportType)
    ) {
      return `${field}.toolContentSupportType[${index}] must be one of: ${TOOL_CONTENT_SUPPORT_TYPES.join(", ")}`
    }

    const typedItem = item as ToolContentSupportType
    if (!seen.has(typedItem)) {
      seen.add(typedItem)
      normalized.push(typedItem)
    }
  }

  if (normalized.length > 0) {
    config.toolContentSupportType = normalized
  }
  return undefined
}

function isJsonLikeValue(value: unknown): boolean {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value)
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonLikeValue(item))
  }

  if (!isPlainObject(value)) return false

  return Object.values(value).every((item) => isJsonLikeValue(item))
}

function applyProviderModelExtraBody(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "extraBody")) return undefined

  const raw = value.extraBody
  if (raw === null || raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    return `${field}.extraBody must be an object`
  }

  for (const key of Object.keys(raw)) {
    if (BLOCKED_KEYS.has(key)) {
      return `${field}.extraBody.${key} is not allowed`
    }
  }
  if (!isJsonLikeValue(raw)) {
    return `${field}.extraBody must contain JSON-compatible values`
  }

  config.extraBody = raw
  return undefined
}

function assignPricingNumber(
  pricing: TokenUsagePricingTier,
  key: (typeof TOKEN_USAGE_PRICING_NUMBER_FIELDS)[number],
  value: number,
): void {
  pricing[key] = value
}

function parseTokenUsagePricingTier(
  value: unknown,
  field: string,
  allowTiers: boolean,
): ParseFieldResult<TokenUsagePricingTier> {
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object` }
  }

  for (const key of Object.keys(value)) {
    if (BLOCKED_KEYS.has(key)) {
      return { error: `${field}.${key} is not allowed` }
    }
    if (!TOKEN_USAGE_PRICING_KEYS.has(key)) {
      return { error: `${field}.${key} is not supported` }
    }
    if (key === "tiers" && !allowTiers) {
      return { error: `${field}.tiers is not supported` }
    }
  }

  const pricing: TokenUsagePricingTier = {}
  for (const key of TOKEN_USAGE_PRICING_NUMBER_FIELDS) {
    if (!Object.hasOwn(value, key)) continue

    const parsed = parseOptionalNonNegativeNumber(value[key], `${field}.${key}`)
    if ("error" in parsed) return parsed
    if ("value" in parsed) assignPricingNumber(pricing, key, parsed.value)
  }

  return { value: pricing }
}

function parseTokenUsagePricingConfig(
  value: unknown,
  field: string,
): ParseFieldResult<TokenUsagePricingConfig> {
  const parsed = parseTokenUsagePricingTier(value, field, true)
  if ("error" in parsed) return parsed

  if ("clear" in parsed) return { value: {} }

  const pricing: TokenUsagePricingConfig = { ...parsed.value }
  if (!isPlainObject(value) || !Object.hasOwn(value, "tiers")) {
    return { value: pricing }
  }

  const rawTiers = value.tiers
  if (rawTiers === null || rawTiers === undefined) {
    return { value: pricing }
  }
  if (!Array.isArray(rawTiers)) {
    return { error: `${field}.tiers must be an array` }
  }

  const tiers: Array<TokenUsagePricingTier> = []
  for (const [index, rawTier] of rawTiers.entries()) {
    const tier = parseTokenUsagePricingTier(
      rawTier,
      `${field}.tiers[${index}]`,
      false,
    )
    if ("error" in tier) return tier
    if ("clear" in tier) continue
    tiers.push(tier.value)
  }
  pricing.tiers = tiers

  return { value: pricing }
}

function applyProviderModelPricing(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "pricing")) return undefined

  const raw = value.pricing
  if (raw === null || raw === undefined) return undefined

  const parsed = parseTokenUsagePricingConfig(raw, `${field}.pricing`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.pricing = parsed.value
  return undefined
}

function parseProviderModelConfig(
  value: unknown,
  field: string,
): ParseFieldResult<ModelConfig> {
  if (value === null || value === undefined) {
    return { error: `${field} must be an object` }
  }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object` }
  }

  const keyError = validateAllowedObjectKeys(
    value,
    field,
    PROVIDER_MODEL_CONFIG_KEYS,
  )
  if (keyError) return { error: keyError }

  const config: ModelConfig = {}

  const temperatureError = applyProviderModelTemperature(config, value, field)
  if (temperatureError) return { error: temperatureError }

  const topPError = applyProviderModelTopP(config, value, field)
  if (topPError) return { error: topPError }

  const topKError = applyProviderModelTopK(config, value, field)
  if (topKError) return { error: topKError }

  const typeError = applyProviderModelType(config, value, field)
  if (typeError) return { error: typeError }

  const contextCacheError = applyProviderModelContextCache(config, value, field)
  if (contextCacheError) return { error: contextCacheError }

  const supportPdfError = applyProviderModelSupportPdf(config, value, field)
  if (supportPdfError) return { error: supportPdfError }

  const toolContentSupportTypeError = applyProviderModelToolContentSupportType(
    config,
    value,
    field,
  )
  if (toolContentSupportTypeError) {
    return { error: toolContentSupportTypeError }
  }

  const extraBodyError = applyProviderModelExtraBody(config, value, field)
  if (extraBodyError) return { error: extraBodyError }

  const pricingError = applyProviderModelPricing(config, value, field)
  if (pricingError) return { error: pricingError }

  return { value: config }
}

function parseProviderModelsRecord(
  value: unknown,
  field: string,
): ParseFieldResult<Record<string, ModelConfig>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object` }
  }

  const record = Object.create(null) as Record<string, ModelConfig>

  for (const [rawModelId, rawModelConfig] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(rawModelId)) {
      return { error: `${field}.${rawModelId} is not allowed` }
    }

    const modelId = rawModelId.trim()
    if (!modelId) {
      return { error: `${field} keys must be non-empty strings` }
    }
    if (rawModelId !== modelId) {
      return {
        error: `${field}.${rawModelId} must not include leading/trailing whitespace`,
      }
    }
    if (BLOCKED_KEYS.has(modelId)) {
      return { error: `${field}.${modelId} is not allowed` }
    }

    const parsed = parseProviderModelConfig(
      rawModelConfig,
      `${field}.${modelId}`,
    )
    if ("error" in parsed) return parsed
    if ("clear" in parsed) continue

    record[modelId] = parsed.value
  }

  return { value: record }
}

function applyProviderType(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "type")) return undefined

  const parsed = parseOptionalString(value.type, `${field}.type`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) {
    if (!isSupportedProviderType(parsed.value)) {
      return `${field}.type must be one of: ${SUPPORTED_PROVIDER_TYPES.map((item) => `"${item}"`).join(", ")}`
    }
    provider.type = parsed.value
  }

  return undefined
}

function applyProviderEnabled(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "enabled")) return undefined

  const parsed = parseOptionalBoolean(value.enabled, `${field}.enabled`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.enabled = parsed.value
  return undefined
}

function applyProviderBaseUrl(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "baseUrl")) return undefined

  const parsed = parseOptionalString(value.baseUrl, `${field}.baseUrl`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.baseUrl = parsed.value
  return undefined
}

function applyProviderApiKey(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "apiKey")) return undefined

  const parsed = parseOptionalString(value.apiKey, `${field}.apiKey`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.apiKey = parsed.value
  return undefined
}

function applyProviderAuthType(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "authType")) return undefined

  const parsed = parseOptionalString(value.authType, `${field}.authType`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) {
    if (!isProviderAuthType(parsed.value)) {
      return `${field}.authType must be one of: ${PROVIDER_AUTH_TYPES.map((item) => `"${item}"`).join(", ")}`
    }
    provider.authType = parsed.value
  }
  return undefined
}

function applyProviderPricingCurrency(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "pricingCurrency")) return undefined

  const parsed = parseOptionalString(
    value.pricingCurrency,
    `${field}.pricingCurrency`,
  )
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.pricingCurrency = parsed.value
  return undefined
}

function applyProviderModels(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "models")) return undefined

  const parsed = parseProviderModelsRecord(value.models, `${field}.models`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.models = parsed.value
  return undefined
}

function applyProviderAdjustInputTokens(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "adjustInputTokens")) return undefined

  const parsed = parseOptionalBoolean(
    value.adjustInputTokens,
    `${field}.adjustInputTokens`,
  )
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.adjustInputTokens = parsed.value
  return undefined
}

function parseProviderConfig(
  value: unknown,
  field: string,
): ParseFieldResult<ProviderConfig> {
  if (value === null || value === undefined) {
    return { error: `${field} must be an object` }
  }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object` }
  }

  const keyError = validateAllowedObjectKeys(value, field, PROVIDER_CONFIG_KEYS)
  if (keyError) return { error: keyError }

  const provider: ProviderConfig = {}

  const typeError = applyProviderType(provider, value, field)
  if (typeError) return { error: typeError }

  const enabledError = applyProviderEnabled(provider, value, field)
  if (enabledError) return { error: enabledError }

  const baseUrlError = applyProviderBaseUrl(provider, value, field)
  if (baseUrlError) return { error: baseUrlError }

  const apiKeyError = applyProviderApiKey(provider, value, field)
  if (apiKeyError) return { error: apiKeyError }

  const authTypeError = applyProviderAuthType(provider, value, field)
  if (authTypeError) return { error: authTypeError }

  const pricingCurrencyError = applyProviderPricingCurrency(
    provider,
    value,
    field,
  )
  if (pricingCurrencyError) return { error: pricingCurrencyError }

  const modelsError = applyProviderModels(provider, value, field)
  if (modelsError) return { error: modelsError }

  const adjustInputTokensError = applyProviderAdjustInputTokens(
    provider,
    value,
    field,
  )
  if (adjustInputTokensError) return { error: adjustInputTokensError }

  return { value: provider }
}

function parseProviders(
  value: unknown,
): ParseFieldResult<Record<string, ProviderConfig>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "providers must be an object" }
  }

  const record = Object.create(null) as Record<string, ProviderConfig>
  const seenProviderNames = new Set<string>()

  for (const [rawProviderName, rawProviderConfig] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(rawProviderName)) {
      return { error: `providers.${rawProviderName} is not allowed` }
    }

    const providerName = rawProviderName.trim()
    if (!providerName) {
      return { error: "providers keys must be non-empty strings" }
    }
    if (rawProviderName !== providerName) {
      return {
        error: `providers.${rawProviderName} must not include leading/trailing whitespace`,
      }
    }
    if (BLOCKED_KEYS.has(providerName)) {
      return { error: `providers.${providerName} is not allowed` }
    }

    const normalizedProviderName = providerName.toLowerCase()
    if (seenProviderNames.has(normalizedProviderName)) {
      return {
        error: `providers.${rawProviderName} conflicts with another provider`,
      }
    }
    seenProviderNames.add(normalizedProviderName)

    const parsed = parseProviderConfig(
      rawProviderConfig,
      `providers.${providerName}`,
    )
    if ("error" in parsed) return parsed
    if ("clear" in parsed) continue

    record[providerName] = parsed.value
  }

  return { value: record }
}

function parseReasoningRecord(
  value: unknown,
): ParseFieldResult<Record<string, ReasoningEffort>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "modelReasoningEfforts must be an object" }
  }

  const record = Object.create(null) as Record<string, ReasoningEffort>
  for (const [model, effort] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(model)) {
      return { error: `modelReasoningEfforts.${model} is not allowed` }
    }
    if (typeof effort !== "string") {
      return { error: `modelReasoningEfforts.${model} must be a string` }
    }
    if (!REASONING_EFFORTS.has(effort as ReasoningEffort)) {
      return {
        error: `modelReasoningEfforts.${model} must be one of ${[
          ...REASONING_EFFORTS,
        ].join(", ")}`,
      }
    }
    record[model] = effort as ReasoningEffort
  }

  return { value: record }
}

type ParsedModelAlias = {
  alias: string
  target: string
  allowOriginal?: boolean
}

function parseModelAliasEntry(
  rawAlias: string,
  rawTarget: unknown,
): ParseFieldResult<ParsedModelAlias> {
  if (BLOCKED_KEYS.has(rawAlias)) {
    return { error: `modelAliases.${rawAlias} is not allowed` }
  }

  const alias = rawAlias.trim().toLowerCase()
  if (!alias) {
    return { error: "modelAliases keys must be non-empty strings" }
  }
  if (BLOCKED_KEYS.has(alias)) {
    return { error: `modelAliases.${alias} is not allowed` }
  }

  let target: string | undefined
  let allowOriginal: boolean | undefined

  if (typeof rawTarget === "string") {
    target = rawTarget.trim()
  } else if (isPlainObject(rawTarget)) {
    const rawTargetValue = rawTarget.target
    if (typeof rawTargetValue !== "string") {
      return { error: `modelAliases.${rawAlias}.target must be a string` }
    }
    target = rawTargetValue.trim()

    if ("allowOriginal" in rawTarget) {
      if (typeof rawTarget.allowOriginal !== "boolean") {
        return {
          error: `modelAliases.${rawAlias}.allowOriginal must be a boolean`,
        }
      }
      allowOriginal = rawTarget.allowOriginal
    }
  } else {
    return { error: `modelAliases.${rawAlias} must be a string or object` }
  }

  if (!target) {
    return { error: `modelAliases.${rawAlias} must be a non-empty string` }
  }
  if (alias === target.toLowerCase()) {
    return { error: `modelAliases.${rawAlias} cannot map to itself` }
  }

  return { value: { alias, target, allowOriginal } }
}

function parseModelAliases(
  value: unknown,
): ParseFieldResult<
  Record<string, { target: string; allowOriginal?: boolean }>
> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "modelAliases must be an object" }
  }

  const record = Object.create(null) as Record<
    string,
    { target: string; allowOriginal?: boolean }
  >

  for (const [rawAlias, rawTarget] of Object.entries(value)) {
    const parsed = parseModelAliasEntry(rawAlias, rawTarget)
    if ("error" in parsed) return parsed
    if ("clear" in parsed) continue

    const { alias, target, allowOriginal } = parsed.value
    const existing = Object.hasOwn(record, alias) ? record[alias] : undefined
    if (
      existing
      && (existing.target !== target
        || existing.allowOriginal !== allowOriginal)
    ) {
      return { error: `modelAliases.${rawAlias} conflicts with ${alias}` }
    }

    record[alias] =
      allowOriginal === undefined ? { target } : { target, allowOriginal }
  }

  return { value: record }
}

function parseModelMappings(
  value: unknown,
): ParseFieldResult<Record<string, string>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "modelMappings must be an object" }
  }

  const record = Object.create(null) as Record<string, string>
  for (const [rawSource, rawTarget] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(rawSource)) {
      return { error: `modelMappings.${rawSource} is not allowed` }
    }

    const source = rawSource.trim()
    if (!source) {
      return { error: "modelMappings keys must be non-empty strings" }
    }
    if (BLOCKED_KEYS.has(source)) {
      return { error: `modelMappings.${source} is not allowed` }
    }
    if (Object.hasOwn(record, source)) {
      return {
        error: `modelMappings.${rawSource} conflicts with normalized key "${source}"`,
      }
    }
    if (typeof rawTarget !== "string") {
      return { error: `modelMappings.${rawSource} must be a string` }
    }

    const target = rawTarget.trim()
    if (!target) {
      return { error: `modelMappings.${rawSource} must be a non-empty string` }
    }

    record[source] = target
  }

  return { value: record }
}

function applyOptionalString(
  next: AppConfig,
  key: "smallModel" | "apiKey" | "anthropicApiKey" | "messageApiWebSearchModel",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalString(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}

function applyAuthConfig(next: AppConfig, value: unknown): string | undefined {
  const parsed = parseAuthConfig(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.auth
    return undefined
  }

  next.auth = parsed.value
  return undefined
}

function applyLogLevel(next: AppConfig, value: unknown): string | undefined {
  const parsed = parseOptionalLogLevel(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next.logLevel = undefined
    return undefined
  }

  next.logLevel = parsed.value
  return undefined
}

function applyOptionalBoolean(
  next: AppConfig,
  key:
    | "accountAffinity"
    | "forceAgent"
    | "useMessagesApi"
    | "useResponsesApiWebSocket"
    | "useResponsesApiWebSearch"
    | "compactUseSmallModel"
    | "messageStartInputTokensFallback"
    | "allowOriginalModelNamesForAliases"
    | "useResponsesApiContextManagement"
    | "copilotUseLocalModels",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalBoolean(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}

function applyOptionalNumber(
  next: AppConfig,
  key: "modelRefreshIntervalHours" | "sessionAffinityRetentionDays",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalNonNegativeNumber(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}

function applyExtraPrompts(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseStringRecord(value, "extraPrompts")
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.extraPrompts
    return undefined
  }
  next.extraPrompts = parsed.value
  return undefined
}

function parseModelResponsesApiCompactThresholds(
  value: unknown,
): ParseFieldResult<Record<string, number>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "modelResponsesApiCompactThresholds must be an object" }
  }

  const record = Object.create(null) as Record<string, number>
  for (const [rawModel, threshold] of Object.entries(value)) {
    const model = rawModel.trim()
    if (!model) {
      return {
        error:
          "modelResponsesApiCompactThresholds keys must be non-empty strings",
      }
    }
    if (BLOCKED_KEYS.has(model)) {
      return {
        error: `modelResponsesApiCompactThresholds.${model} is not allowed`,
      }
    }
    if (Object.hasOwn(record, model)) {
      return {
        error: `modelResponsesApiCompactThresholds.${rawModel} conflicts with normalized key "${model}"`,
      }
    }
    if (typeof threshold !== "number") {
      return {
        error: `modelResponsesApiCompactThresholds.${rawModel} must be a number`,
      }
    }
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return {
        error: `modelResponsesApiCompactThresholds.${rawModel} must be a positive finite number`,
      }
    }

    record[model] = threshold
  }

  return { value: record }
}

function applyReasoningEfforts(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseReasoningRecord(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.modelReasoningEfforts
    return undefined
  }
  next.modelReasoningEfforts = parsed.value
  return undefined
}

function applyModelResponsesApiCompactThresholds(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseModelResponsesApiCompactThresholds(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.modelResponsesApiCompactThresholds
    return undefined
  }
  next.modelResponsesApiCompactThresholds = parsed.value
  return undefined
}

function applyModelAliases(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseModelAliases(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.modelAliases
    return undefined
  }
  next.modelAliases = parsed.value
  return undefined
}

function applyModelMappings(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseModelMappings(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.modelMappings
    return undefined
  }
  next.modelMappings = parsed.value
  return undefined
}

function applyResponsesApiContextManagementModels(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseOptionalStringArray(
    value,
    "responsesApiContextManagementModels",
  )
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.responsesApiContextManagementModels
    return undefined
  }
  next.responsesApiContextManagementModels = parsed.value
  return undefined
}

function applyProvidersConfig(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseProviders(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.providers
    return undefined
  }
  next.providers = parsed.value
  return undefined
}

const DEV_MODE_KEYS = new Set([
  "enabled",
  "capture4xx",
  "capture5xx",
  "captureOther",
])

function parseDevModeConfig(value: unknown): ParseFieldResult<DevModeConfig> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) return { error: "devMode must be an object" }

  for (const key of Object.keys(value)) {
    if (!DEV_MODE_KEYS.has(key)) {
      return { error: `devMode.${key} is not supported` }
    }
  }

  for (const key of DEV_MODE_KEYS) {
    const v = value[key]
    if (v !== undefined && typeof v !== "boolean") {
      return { error: `devMode.${key} must be a boolean` }
    }
  }

  return {
    value: {
      enabled: value.enabled === true,
      capture4xx: value.capture4xx === true,
      capture5xx: value.capture5xx === true,
      captureOther: value.captureOther === true,
    },
  }
}

function applyDevModeConfig(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseDevModeConfig(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next.devMode = {
      enabled: false,
      capture4xx: false,
      capture5xx: false,
      captureOther: false,
    }
    return undefined
  }
  next.devMode = parsed.value
  return undefined
}

const QUOTA_REFRESH_KEYS = new Set([
  "enabled",
  "intervalMinutes",
  "startupDelaySeconds",
  "staggerMinSeconds",
  "staggerMaxSeconds",
])

function parseQuotaRefreshConfig(
  value: unknown,
): ParseFieldResult<QuotaRefreshConfig> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) return { error: "quotaRefresh must be an object" }

  for (const key of Object.keys(value)) {
    if (!QUOTA_REFRESH_KEYS.has(key)) {
      return { error: `quotaRefresh.${key} is not supported` }
    }
  }

  const out: QuotaRefreshConfig = {}

  if (Object.hasOwn(value, "enabled")) {
    const parsed = parseOptionalBoolean(value.enabled, "quotaRefresh.enabled")
    if ("error" in parsed) return parsed
    if ("value" in parsed) out.enabled = parsed.value
  }

  for (const key of [
    "intervalMinutes",
    "startupDelaySeconds",
    "staggerMinSeconds",
    "staggerMaxSeconds",
  ] as const) {
    if (!Object.hasOwn(value, key)) {
      continue
    }

    const parsed = parseOptionalNonNegativeNumber(
      value[key],
      `quotaRefresh.${key}`,
    )
    if ("error" in parsed) return parsed
    if ("value" in parsed) out[key] = parsed.value
  }

  return { value: out }
}

function applyQuotaRefreshConfig(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseQuotaRefreshConfig(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.quotaRefresh
    return undefined
  }
  next.quotaRefresh =
    next.quotaRefresh === undefined ?
      parsed.value
    : {
        ...next.quotaRefresh,
        ...parsed.value,
      }
  return undefined
}

type ConfigPatchHandler = (
  next: AppConfig,
  value: unknown,
) => string | undefined

const CONFIG_PATCH_HANDLERS: Partial<Record<string, ConfigPatchHandler>> = {
  auth: applyAuthConfig,
  extraPrompts: applyExtraPrompts,
  smallModel: (next, value) => applyOptionalString(next, "smallModel", value),
  logLevel: applyLogLevel,
  accountAffinity: (next, value) =>
    applyOptionalBoolean(next, "accountAffinity", value),
  apiKey: (next, value) => applyOptionalString(next, "apiKey", value),
  anthropicApiKey: (next, value) =>
    applyOptionalString(next, "anthropicApiKey", value),
  providers: applyProvidersConfig,
  responsesApiContextManagementModels: applyResponsesApiContextManagementModels,
  modelReasoningEfforts: applyReasoningEfforts,
  modelResponsesApiCompactThresholds: applyModelResponsesApiCompactThresholds,
  modelAliases: applyModelAliases,
  modelMappings: applyModelMappings,
  allowOriginalModelNamesForAliases: (next, value) =>
    applyOptionalBoolean(next, "allowOriginalModelNamesForAliases", value),
  forceAgent: (next, value) => applyOptionalBoolean(next, "forceAgent", value),
  compactUseSmallModel: (next, value) =>
    applyOptionalBoolean(next, "compactUseSmallModel", value),
  messageStartInputTokensFallback: (next, value) =>
    applyOptionalBoolean(next, "messageStartInputTokensFallback", value),
  modelRefreshIntervalHours: (next, value) =>
    applyOptionalNumber(next, "modelRefreshIntervalHours", value),
  sessionAffinityRetentionDays: (next, value) =>
    applyOptionalNumber(next, "sessionAffinityRetentionDays", value),
  useMessagesApi: (next, value) =>
    applyOptionalBoolean(next, "useMessagesApi", value),
  useResponsesApiWebSocket: (next, value) =>
    applyOptionalBoolean(next, "useResponsesApiWebSocket", value),
  useResponsesApiWebSearch: (next, value) =>
    applyOptionalBoolean(next, "useResponsesApiWebSearch", value),
  messageApiWebSearchModel: (next, value) =>
    applyOptionalString(next, "messageApiWebSearchModel", value),
  useResponsesApiContextManagement: (next, value) =>
    applyOptionalBoolean(next, "useResponsesApiContextManagement", value),
  copilotUseLocalModels: (next, value) =>
    applyOptionalBoolean(next, "copilotUseLocalModels", value),
  devMode: applyDevModeConfig,
  quotaRefresh: applyQuotaRefreshConfig,
}

function applyConfigPatch(
  base: AppConfig,
  input: Record<string, unknown>,
): { config?: AppConfig; error?: string } {
  const next: AppConfig = { ...base }

  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey as keyof AppConfig
    if (!CONFIG_KEYS.has(key)) {
      return { error: `Unknown config key: ${rawKey}` }
    }

    const handler = CONFIG_PATCH_HANDLERS[rawKey]
    if (!handler) {
      return { error: `Unsupported config key: ${rawKey}` }
    }

    const error = handler(next, value)
    if (error) return { error }
  }

  return { config: next }
}

export const adminApiRoutes = new Hono()

adminApiRoutes.use("*", async (c, next) => {
  const decision = decideAdminAccess(c)
  if (!decision.ok) {
    return c.json(
      {
        error: {
          message: decision.message,
          type: decision.errorType,
        },
      },
      decision.status,
    )
  }

  await next()
})

// Start auth session cleanup timer
authSessionManager.start()

adminApiRoutes.get("/meta", (c) => {
  const store = getRequestHistoryStore()
  return c.json(store.meta())
})

function applyAdminConfigResponseDefaults(config: AppConfig): AppConfig {
  return {
    ...config,
    modelMappings: config.modelMappings ?? {},
    useResponsesApiContextManagement:
      config.useResponsesApiContextManagement ?? true,
  }
}

adminApiRoutes.get("/config", (c) => {
  try {
    const config = applyAdminConfigResponseDefaults(mergeConfigWithDefaults())
    return c.json({ ...config, _configPath: PATHS.CONFIG_PATH })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to load config.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.post("/config", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return jsonError(c, 400, {
      message: "Config payload must be valid JSON.",
      type: "bad_request",
    })
  }

  if (!isPlainObject(payload)) {
    return jsonError(c, 400, {
      message: "Config payload must be an object.",
      type: "bad_request",
    })
  }

  const result = applyConfigPatch(getConfig(), payload)
  if (!result.config) {
    return jsonError(c, 400, {
      message: result.error ?? "Invalid config payload.",
      type: "bad_request",
    })
  }

  try {
    await writeConfigFile(result.config)
    const merged = applyAdminConfigResponseDefaults(mergeConfigWithDefaults())
    accountsManager.setAccountAffinityEnabled(isAccountAffinityEnabled())
    accountsManager.setModelsRefreshIntervalMs(getModelRefreshIntervalMs())
    updateQuotaRefreshSchedulerFromConfig()
    applySharedSessionAffinityRetention()
    return c.json({ ...merged, _configPath: PATHS.CONFIG_PATH })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to write config.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/models", (c) => {
  try {
    const accountModels = accountsManager.getFirstAccountModels()
    const items =
      accountModels?.data
        .map((model) => model.id)
        .filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        ) ?? []
    const aliasItems = Object.keys(getModelAliases())
    const uniqueItems = Array.from(new Set([...items, ...aliasItems])).sort()
    return c.json({ items: uniqueItems })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to load models.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/models/aggregated", async (c) => {
  try {
    return c.json(await getAggregatedModelsResponse(c.req.raw.headers))
  } catch {
    return jsonError(c, 500, {
      message: "Failed to load aggregated models.",
      type: "internal_error",
    })
  }
})

type AdminModelTokenPrices = {
  batch_size?: number
  cache_price?: number
  input_price?: number
  output_price?: number
}

type AdminModelDetailsItem = {
  id: string
  name: string
  preview: boolean
  billing?: {
    is_premium?: boolean
    multiplier?: number
    token_based?: boolean
    token_prices?: AdminModelTokenPrices
  }
  supported_endpoints?: Array<string>
  capabilities: {
    limits: {
      max_context_window_tokens?: number
      max_prompt_tokens?: number
      max_output_tokens?: number
    }
    supports: {
      tool_calls?: boolean
      parallel_tool_calls?: boolean
      structured_outputs?: boolean
      streaming?: boolean
      vision?: boolean
      reasoning_effort?: Array<string>
    }
  }
  aliases: Array<string>
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseOptionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  return Number.isFinite(value) ? value : undefined
}

function toBooleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function parseStringArray(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined

  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  return out.length > 0 ? out : undefined
}

function parseTokenPrices(value: unknown): AdminModelTokenPrices | undefined {
  if (!isPlainObject(value)) return undefined

  const token_prices: AdminModelTokenPrices = {
    batch_size: parseOptionalFiniteNumber(value.batch_size),
    cache_price: parseOptionalFiniteNumber(value.cache_price),
    input_price: parseOptionalFiniteNumber(value.input_price),
    output_price: parseOptionalFiniteNumber(value.output_price),
  }

  return Object.values(token_prices).some((price) => price !== undefined) ?
      token_prices
    : undefined
}

function parseBilling(value: unknown): AdminModelDetailsItem["billing"] {
  if (!isPlainObject(value)) return undefined

  const multiplier = parseOptionalFiniteNumber(value.multiplier)
  const is_premium = toBooleanOrUndefined(value.is_premium)
  const token_prices = parseTokenPrices(value.token_prices)
  const token_based = token_prices !== undefined ? true : undefined

  if (
    multiplier === undefined
    && is_premium === undefined
    && token_prices === undefined
  ) {
    return undefined
  }

  return { multiplier, is_premium, token_based, token_prices }
}

function parseCapabilities(
  value: unknown,
): AdminModelDetailsItem["capabilities"] {
  if (!isPlainObject(value)) {
    return {
      limits: {},
      supports: {},
    }
  }

  const limitsRaw = isPlainObject(value.limits) ? value.limits : undefined
  const supportsRaw = isPlainObject(value.supports) ? value.supports : undefined

  return {
    limits: {
      max_context_window_tokens: parseOptionalFiniteNumber(
        limitsRaw?.max_context_window_tokens,
      ),
      max_prompt_tokens: parseOptionalFiniteNumber(
        limitsRaw?.max_prompt_tokens,
      ),
      max_output_tokens: parseOptionalFiniteNumber(
        limitsRaw?.max_output_tokens,
      ),
    },
    supports: {
      tool_calls: toBooleanOrUndefined(supportsRaw?.tool_calls),
      parallel_tool_calls: toBooleanOrUndefined(
        supportsRaw?.parallel_tool_calls,
      ),
      structured_outputs: toBooleanOrUndefined(supportsRaw?.structured_outputs),
      streaming: toBooleanOrUndefined(supportsRaw?.streaming),
      vision: toBooleanOrUndefined(supportsRaw?.vision),
      reasoning_effort: parseReasoningEffortSupport(
        Array.isArray(supportsRaw?.reasoning_effort) ?
          supportsRaw.reasoning_effort
        : undefined,
      ),
    },
  }
}

function parseAdminModelDetailsItem(
  raw: unknown,
  aliasesByTarget: Map<string, Array<string>>,
): AdminModelDetailsItem | null {
  if (!isPlainObject(raw)) return null

  const id = parseNonEmptyString(raw.id)
  if (!id) return null

  const name = parseNonEmptyString(raw.name) ?? id
  const preview = toBooleanOrUndefined(raw.preview) ?? false

  return {
    id,
    name,
    preview,
    billing: parseBilling(raw.billing),
    supported_endpoints: parseStringArray(raw.supported_endpoints),
    capabilities: parseCapabilities(raw.capabilities),
    aliases: aliasesByTarget.get(id.toLowerCase()) ?? [],
  }
}

adminApiRoutes.get("/models/details", (c) => {
  try {
    const accountModels = accountsManager.getFirstAccountModels()
    const aliasInfo = getModelAliasesInfo()

    const aliasesByTarget = new Map<string, Array<string>>()
    for (const [alias, spec] of Object.entries(aliasInfo)) {
      const targetKey = spec.target.toLowerCase()
      const current = aliasesByTarget.get(targetKey)
      if (current) {
        current.push(alias)
      } else {
        aliasesByTarget.set(targetKey, [alias])
      }
    }

    for (const aliases of aliasesByTarget.values()) {
      aliases.sort()
    }

    const rawModels: Array<unknown> = []
    if (Array.isArray(accountModels?.data)) {
      rawModels.push(...(accountModels.data as Array<unknown>))
    }

    const itemsById = new Map<string, AdminModelDetailsItem>()
    for (const raw of rawModels) {
      const item = parseAdminModelDetailsItem(raw, aliasesByTarget)
      if (!item) continue
      if (itemsById.has(item.id)) continue
      itemsById.set(item.id, item)
    }

    const items = Array.from(itemsById.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    )

    return c.json({ items })
  } catch (error) {
    console.error("Failed to load model details.", error)
    return jsonError(c, 500, {
      message: "Failed to load model details.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/accounts", async (c) => {
  const url = new URL(c.req.url, "http://local")
  const sinceMs = Number(url.searchParams.get("since_ms") ?? "")
  const includeStats = url.searchParams.get("include_stats") !== "0"

  let since = Date.now() - 24 * 60 * 60 * 1000
  if (Number.isFinite(sinceMs) && sinceMs > 0) {
    since = sinceMs
  }

  const registry = await listAccountsFromRegistry().catch(() => [])
  const registryTypeById = new Map(registry.map((a) => [a.id, a.accountType]))

  const statuses = accountsManager.getAccountStatus()

  const store = getRequestHistoryStore()
  const statsByAccount: Record<string, AccountStatsRow | undefined> =
    includeStats ? store.getAccountStatsSince(since) : {}

  const items: Array<AccountItem> = statuses.map((s) => {
    const accountType = registryTypeById.get(s.id)
    const statsRow = includeStats ? statsByAccount[s.id] : undefined

    const stats =
      includeStats ?
        {
          since_ms: since,
          request_count: statsRow?.request_count,
          error_count: statsRow?.error_count,
          tokens_total: statsRow?.tokens_total,
          avg_duration_ms: statsRow?.avg_duration_ms,
          last_request_at_ms: statsRow?.last_request_at_ms,
        }
      : undefined

    return {
      account_id: s.id,
      account_type: accountType,
      runtime: {
        entitlement: s.entitlement,
        remaining: s.remaining,
        unlimited: s.unlimited,
        creditsEntitlement: s.entitlement,
        creditsRemaining: s.remaining,
        creditsUnlimited: s.unlimited,
        overagePermitted: s.overagePermitted,
        tokenBasedBilling: s.tokenBasedBilling,
        failed: s.failed,
        failureReason: s.failureReason,
        enabled: s.enabled,
        lastModelsFetch: s.lastModelsFetch,
        isRefreshingModels: s.isRefreshingModels,
      },
      stats,
    }
  })

  return c.json({ items })
})

adminApiRoutes.post("/accounts/models/refresh", async (c) => {
  const { failedCount } = await accountsManager.refreshAllModelsNow()
  return c.json({ ok: true, failedCount })
})

adminApiRoutes.get("/requests", (c) => {
  const url = new URL(c.req.url, "http://local")
  const p = url.searchParams

  const limit = parseFiniteNumber(p.get("limit")) ?? 50
  const cursorId = parseFiniteNumber(p.get("cursor_id"))

  const status = parseFiniteNumber(p.get("status"))
  const hasError = parseTriStateBool(p.get("has_error"))

  const fromMs = parseFiniteNumber(p.get("from_ms"))
  const toMs = parseFiniteNumber(p.get("to_ms"))

  const store = getRequestHistoryStore()
  const result = store.query({
    limit,
    cursorId,

    accountId: p.get("account_id") || undefined,
    upstreamModel: p.get("upstream_model") || undefined,
    clientModel: p.get("client_model") || undefined,
    upstreamEndpoint: p.get("upstream_endpoint") || undefined,
    path: p.get("path") || undefined,

    status,
    hasError,
    fromMs,
    toMs,
  })

  const outboundIds = getRequestOutboundStore().hasOutboundForIds(
    result.items.map((i) => i.request_id),
  )
  const itemsWithOutbound = result.items.map((item) => ({
    ...toAdminRequestLogRow(item),
    has_outbound: outboundIds.has(item.request_id),
  }))

  return c.json({
    items: itemsWithOutbound,
    next_cursor_id: result.nextCursorId,
    has_more: result.hasMore,
  })
})

adminApiRoutes.get("/requests/:requestId", (c) => {
  const requestId = c.req.param("requestId")
  const store = getRequestHistoryStore()
  const item = store.getByRequestId(requestId)
  const hasOutbound =
    item !== null
    && getRequestOutboundStore().getByRequestId(requestId) !== null
  return c.json({
    item: item ? toAdminRequestLogRow(item) : null,
    has_outbound: hasOutbound,
  })
})

adminApiRoutes.post("/accounts/auth/start", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return jsonError(c, 400, {
      message: "Request body must be valid JSON.",
      type: "bad_request",
    })
  }

  if (!isPlainObject(payload)) {
    return jsonError(c, 400, {
      message: "Request body must be an object.",
      type: "bad_request",
    })
  }

  const accountType = payload.accountType
  if (!isAccountType(accountType)) {
    return jsonError(c, 400, {
      message: "accountType must be one of: individual, business, enterprise",
      type: "bad_request",
    })
  }

  // Enterprise accounts may optionally provide a custom GHE/GHES domain.
  // When omitted, auth stays on the public github.com flow.
  const enterpriseDomainRaw = payload.enterpriseDomain
  let enterpriseDomain: string | undefined
  if (accountType === "enterprise" && typeof enterpriseDomainRaw === "string") {
    enterpriseDomain = enterpriseDomainRaw.trim() || undefined
  }

  try {
    const result = await authSessionManager.startAuth({
      accountType,
      enterpriseDomain,
    })
    return c.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return jsonError(c, 500, {
      message: `Failed to start auth: ${msg}`,
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/accounts/auth/status/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId")
  const status = authSessionManager.getStatus(sessionId)

  if (!status) {
    return jsonError(c, 404, {
      message: "Session not found.",
      type: "not_found",
    })
  }

  return c.json(status)
})

adminApiRoutes.post("/accounts/auth/cancel/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId")
  const cancelled = authSessionManager.cancel(sessionId)

  if (!cancelled) {
    return jsonError(c, 404, {
      message: "Session not found.",
      type: "not_found",
    })
  }

  return c.json({ cancelled: true })
})

adminApiRoutes.patch("/accounts/:id", async (c) => {
  const accountId = c.req.param("id")

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return jsonError(c, 400, {
      message: "Invalid JSON body.",
      type: "bad_request",
    })
  }

  if (
    typeof payload !== "object"
    || payload === null
    || Array.isArray(payload)
    || typeof (payload as Record<string, unknown>).enabled !== "boolean"
  ) {
    return jsonError(c, 400, {
      message: "Request body must contain { enabled: boolean }.",
      type: "bad_request",
    })
  }

  const enabled = (payload as Record<string, unknown>).enabled as boolean

  try {
    const registry = await loadRegistry()
    const entry = registry.accounts.find((a) => a.id === accountId)

    if (!entry) {
      return jsonError(c, 404, {
        message: "Account not found.",
        type: "not_found",
      })
    }

    entry.enabled = enabled
    await saveRegistry(registry)
    await accountsManager.reloadRegistryNow()

    return c.json({ success: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return jsonError(c, 500, {
      message: `Failed to update account: ${msg}`,
      type: "internal_error",
    })
  }
})

adminApiRoutes.delete("/accounts/:id", async (c) => {
  const accountId = c.req.param("id")

  try {
    const accounts = await listAccountsFromRegistry()
    const exists = accounts.some((a) => a.id === accountId)

    if (!exists) {
      return jsonError(c, 404, {
        message: "Account not found.",
        type: "not_found",
      })
    }

    // Remove registry entry first (authoritative state), then token file.
    // If registry removal succeeds but token removal fails, the orphaned
    // token file is harmless and will be ignored on next startup.
    await removeAccountFromRegistry(accountId)
    try {
      await removeAccountToken(accountId)
    } catch (error) {
      console.error(
        `Account ${accountId} deleted but token cleanup failed.`,
        error,
      )
    }

    // Force immediate reload so the next GET /accounts reflects the deletion
    await accountsManager.reloadRegistryNow()

    return c.json({ deleted: true, accountId })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return jsonError(c, 500, {
      message: `Failed to delete account: ${msg}`,
      type: "internal_error",
    })
  }
})

adminApiRoutes.post("/accounts/:id/reauth", async (c) => {
  const accountId = c.req.param("id")

  try {
    const accounts = await listAccountsFromRegistry()
    const account = accounts.find((a) => a.id === accountId)

    if (!account) {
      return jsonError(c, 404, {
        message: "Account not found.",
        type: "not_found",
      })
    }

    const { oauthApp } = getCurrentIdentityEnvironment()
    const clientIdentity = await getAccountClientIdentityByLoginAndApp(
      accountId,
      oauthApp,
    )

    // Use the stored enterprise domain if it's not the default "public"
    const resolvedEnterpriseDomain = clientIdentity?.enterpriseDomain
    let enterpriseDomain: string | undefined
    if (
      resolvedEnterpriseDomain
      && resolvedEnterpriseDomain !== DEFAULT_IDENTITY_ENTERPRISE_DOMAIN
    ) {
      enterpriseDomain = resolvedEnterpriseDomain
    }

    const result = await authSessionManager.startAuth({
      accountType: account.accountType,
      enterpriseDomain,
      reauthAccountId: accountId,
    })

    return c.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return jsonError(c, 500, {
      message: `Failed to start reauth: ${msg}`,
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/token-usage", async (c) => {
  const url = new URL(c.req.url, "http://local")
  const period = parseTokenUsagePeriod(url.searchParams.get("period"))
  const summary = await getTokenUsageSummary(period)
  return c.json(summary)
})

adminApiRoutes.get("/token-usage/daily", async (c) => {
  const url = new URL(c.req.url, "http://local")
  const period = parseTokenUsagePeriod(url.searchParams.get("period"))
  const summary = await getTokenUsageDailySummary(period)
  return c.json(summary)
})

adminApiRoutes.get("/token-usage/events", async (c) => {
  const url = new URL(c.req.url, "http://local")
  const p = url.searchParams
  const period = parseTokenUsagePeriod(p.get("period"))
  const page = parsePositiveInt(p.get("page"), 1)
  const pageSize = parsePositiveInt(
    p.get("page_size"),
    DEFAULT_TOKEN_USAGE_EVENTS_PAGE_SIZE,
  )
  const eventsPage = await getTokenUsageEventsPage({ page, pageSize, period })
  return c.json(eventsPage)
})

adminApiRoutes.get("/stats/premium-daily", (c) => {
  const url = new URL(c.req.url, "http://local")
  const p = url.searchParams

  const from = p.get("from") || undefined
  const to = p.get("to") || undefined
  const accountId = p.get("account_id") || undefined
  const granularity = p.get("granularity") === "hour" ? "hour" : "day"

  const now = new Date()
  const todayStr = toLocalDateString(now.getTime())

  const resolvedFrom =
    from
    || toLocalDateString(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime(),
    )
  const resolvedTo = to || todayStr

  // Parse YYYY-MM-DD as local time (not UTC)
  function parseLocalDate(dateStr: string): Date {
    const [y, m, d] = dateStr.split("-").map(Number)
    return new Date(y, m - 1, d)
  }

  /** DST-safe end-of-day: next local midnight minus 1 ms. */
  function localDateEndMs(dateStr: string): number {
    const [y, m, d] = dateStr.split("-").map(Number)
    return new Date(y, m - 1, d + 1).getTime() - 1
  }

  const statsStore = getStatsStore()
  if (!statsStore) {
    return c.json({
      daily: [],
      by_account: [],
      range: { from: resolvedFrom, to: resolvedTo, granularity },
    })
  }

  if (granularity === "hour") {
    // Prefer client-provided ms boundaries (browser local time)
    const clientFromMs = parseFiniteNumber(p.get("from_ms"))
    const clientToMs = parseFiniteNumber(p.get("to_ms"))

    let fromMs: number
    let toMs: number

    if (clientFromMs !== undefined && clientToMs !== undefined) {
      fromMs = clientFromMs
      toMs = clientToMs
    } else {
      // Fallback: DST-safe computation from date strings
      fromMs = parseLocalDate(resolvedFrom).getTime()
      toMs = localDateEndMs(resolvedTo)
    }

    // Keep raw-hour transport within a bounded range so the admin query stays predictable.
    if (toMs - fromMs > 35 * 24 * 60 * 60 * 1000) {
      return jsonError(c, 400, {
        message:
          "Hourly granularity is only supported for ranges up to 35 days.",
        type: "bad_request",
      })
    }

    const result = statsStore.getHourlyPremiumStats({
      fromMs,
      toMs,
      accountId,
    })
    return c.json({
      daily: result.daily,
      by_account: result.byAccount,
      range: { from: resolvedFrom, to: resolvedTo, granularity },
    })
  }

  const result = statsStore.getDailyPremiumStats({
    from: resolvedFrom,
    to: resolvedTo,
    accountId,
  })
  return c.json({
    daily: result.daily,
    by_account: result.byAccount,
    range: { from: resolvedFrom, to: resolvedTo, granularity },
  })
})

adminApiRoutes.route("/", replayRoutes)
