import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"

import {
  AdminApiError,
  type AdminConfig,
  type AdminConfigResponse,
  type AdminModelDetailsItem,
  type DevModeState,
  type ModelAliasSpec,
  type ProviderAuthType,
  type ProviderConfig,
  type ProviderModelConfig,
  type ProviderType,
  type ReasoningEffort,
  type TokenUsagePricingConfig,
  type TokenUsagePricingTier,
  type ToolContentSupportType,
  getAdminConfig,
  getAdminModelDetails,
  getAdminModels,
  getDevMode,
  setDevMode,
  updateAdminConfig,
} from "@/lib/admin-api"
import { i18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  FloatingSaveButton,
  SettingsNavigation,
  SettingsSectionCard,
} from "@/components/settings"
import { useActiveSection, type SettingsSection } from "@/hooks/use-active-section"
import { InlineAlert } from "@/components/ui/inline-alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const SETTINGS_SECTION_IDS = [
  "general",
  "reasoning",
  "responsesApi",
  "aliases",
  "mappings",
  "prompts",
  "advanced",
  "providers",
  "devMode",
] as const

const REASONING_EFFORTS: Array<ReasoningEffort> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const PROVIDER_TYPES: Array<ProviderType> = [
  "anthropic",
  "openai-compatible",
  "openai-responses",
]

const PROVIDER_AUTH_TYPES: Array<ProviderAuthType> = [
  "x-api-key",
  "authorization",
  "oauth2",
]

const TOOL_CONTENT_SUPPORT_TYPES: Array<ToolContentSupportType> = [
  "array",
  "image",
  "pdf",
]

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

export type QuickProviderName =
  | "opencode-go"
  | "deepseek"
  | "dashscope"
  | "openrouter"
  | "custom"

type QuickProviderTemplate = {
  name: string
  type: ProviderType
  baseUrl: string
  pricingCurrency: string
}

const QUICK_PROVIDER_TEMPLATES = {
  "opencode-go": {
    name: "opencode-go",
    type: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go",
    pricingCurrency: "USD",
  },
  deepseek: {
    name: "deepseek",
    type: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    pricingCurrency: "CNY",
  },
  dashscope: {
    name: "dashscope",
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    pricingCurrency: "CNY",
  },
  openrouter: {
    name: "openrouter",
    type: "anthropic",
    baseUrl: "https://openrouter.ai/api",
    pricingCurrency: "USD",
  },
  custom: {
    name: "",
    type: "anthropic",
    baseUrl: "",
    pricingCurrency: "",
  },
} satisfies Record<QuickProviderName, QuickProviderTemplate>

type ExtraPromptItem = {
  id: string
  model: string
  prompt: string
}

type ReasoningItem = {
  id: string
  model: string
  effort: ReasoningEffort
}

export type ReasoningSupportInfo = {
  efforts: Array<ReasoningEffort>
  target?: string
}

type CompactThresholdItem = {
  id: string
  model: string
  /** Raw input value preserved for editing UX. The numeric record is derived from this. */
  threshold: string
}

type ModelAliasItem = {
  id: string
  alias: string
  target: string
  allowOriginal?: boolean
}

type ModelAliasRecord = Record<string, ModelAliasSpec>

type ModelAliasRecordInput = Record<string, ModelAliasSpec | string>

type ModelMappingItem = {
  id: string
  source: string
  target: string
}

type ProviderModelItem = {
  id: string
  model: string
  temperature: string
  topP: string
  topK: string
  modelType: string
  modelTypeConfigured: boolean
  contextCache: boolean
  contextCacheConfigured: boolean
  supportPdf: boolean
  supportPdfConfigured: boolean
  toolContentSupportType: Array<ToolContentSupportType>
  pricingJson: string
  extraBodyJson: string
}

type ProviderItem = {
  id: string
  name: string
  type: string
  enabled: boolean
  baseUrl: string
  apiKey: string
  authType: ProviderAuthType
  pricingCurrency: string
  adjustInputTokens: boolean
  models: Array<ProviderModelItem>
}

type ProviderRecord = Record<string, ProviderConfig>

type ParseResult<T> = { record: T } | { error: string }

type JsonMode = "form" | "json"

type ToggleJsonModeOptions<TRecord> = {
  next: boolean
  record: TRecord | undefined
  setJson: (value: string) => void
  setError: (value: string | null) => void
  setMode: (mode: JsonMode) => void
}

type UpdateJsonRecordOptions<TRecord> = {
  value: string
  parse: (value: string) => ParseResult<TRecord>
  setJson: (value: string) => void
  setError: (value: string | null) => void
  onRecord: (record: TRecord) => void
}

function toggleJsonMode<TRecord>({
  next,
  record,
  setJson,
  setError,
  setMode,
}: ToggleJsonModeOptions<TRecord>): void {
  if (next) {
    setJson(JSON.stringify(record ?? {}, null, 2))
  }
  setError(null)
  setMode(next ? "json" : "form")
}

function updateJsonRecord<TRecord>({
  value,
  parse,
  setJson,
  setError,
  onRecord,
}: UpdateJsonRecordOptions<TRecord>): void {
  setJson(value)
  const result = parse(value)
  if ("error" in result) {
    setError(result.error)
    return
  }
  setError(null)
  onRecord(result.record)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type ComparablePrimitive = boolean | null | number | string

interface ComparableObject {
  [key: string]: ComparableValue
}

type ComparableValue = Array<ComparableValue> | ComparableObject | ComparablePrimitive

function normalizeComparableValue(value: unknown): ComparableValue | undefined {
  if (value === undefined) return undefined

  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    return value
  }

  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeComparableValue(item))
      .filter((item): item is ComparableValue => item !== undefined)

    if (items.length === 0) return undefined

    if (items.every((item) => typeof item !== "object" || item === null)) {
      items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }

    return items
  }

  if (!isPlainObject(value)) return undefined

  const entries = Object.entries(value)
    .map(([key, item]) => [key, normalizeComparableValue(item)] as const)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))

  if (entries.length === 0) return undefined

  return Object.fromEntries(entries) as Record<string, ComparableValue>
}

function toComparableDraftJson(value: AdminConfig): string {
  return JSON.stringify(normalizeComparableValue(value) ?? {})
}

function createItemId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizeAuthApiKeys(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []

  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )]
}

function getAuthApiKeysFromConfig(config: AdminConfig): Array<string> {
  const configuredApiKeys = normalizeAuthApiKeys(config.auth?.apiKeys)
  if (configuredApiKeys.length > 0) {
    return configuredApiKeys
  }

  const legacyApiKey = config.apiKey?.trim()
  return legacyApiKey ? [legacyApiKey] : []
}

type ContextManagementDraft = {
  messages: boolean
  responses: boolean
}

function getContextManagementFromConfig(
  config: AdminConfig,
): ContextManagementDraft {
  return {
    messages:
      config.contextManagement?.messages
      ?? config.useResponsesApiContextManagement
      ?? true,
    responses: config.contextManagement?.responses ?? false,
  }
}

function parseAuthApiKeysInput(value: string): Array<string> {
  return parseStringListInput(value)
}

function parseStringListInput(value: string): Array<string> {
  return [
    ...new Set(
      value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ]
}

function extraPromptItemsFromRecord(
  record: Record<string, string> | undefined
): Array<ExtraPromptItem> {
  if (!record) return []
  return Object.entries(record).map(([model, prompt]) => ({
    id: createItemId(),
    model,
    prompt,
  }))
}

function reasoningItemsFromRecord(
  record: Record<string, ReasoningEffort> | undefined
): Array<ReasoningItem> {
  if (!record) return []
  return Object.entries(record).map(([model, effort]) => ({
    id: createItemId(),
    model,
    effort,
  }))
}

function compactThresholdItemsFromRecord(
  record: Record<string, number> | undefined,
): Array<CompactThresholdItem> {
  if (!record) return []
  return Object.entries(record).map(([model, threshold]) => ({
    id: createItemId(),
    model,
    threshold: Number.isFinite(threshold) ? String(threshold) : "",
  }))
}

function aliasItemsFromRecord(
  record: ModelAliasRecordInput | undefined
): Array<ModelAliasItem> {
  if (!record) return []
  return Object.entries(record).map(([alias, spec]) => {
    if (typeof spec === "string") {
      return {
        id: createItemId(),
        alias,
        target: spec,
        allowOriginal: undefined,
      }
    }
    return {
      id: createItemId(),
      alias,
      target: spec.target,
      allowOriginal: spec.allowOriginal,
    }
  })
}

function modelMappingItemsFromRecord(
  record: Record<string, string> | undefined,
): Array<ModelMappingItem> {
  if (!record) return []
  return Object.entries(record).map(([source, target]) => ({
    id: createItemId(),
    source,
    target,
  }))
}

function extraPromptRecordFromItems(
  items: Array<ExtraPromptItem>
): Record<string, string> {
  const record: Record<string, string> = {}
  for (const item of items) {
    const key = item.model.trim()
    if (!key) continue
    record[key] = item.prompt
  }
  return record
}

function reasoningRecordFromItems(
  items: Array<ReasoningItem>
): Record<string, ReasoningEffort> {
  const record: Record<string, ReasoningEffort> = {}
  for (const item of items) {
    const key = item.model.trim()
    if (!key) continue
    record[key] = item.effort
  }
  return record
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
}

function normalizeReasoningSupport(
  values: ReadonlyArray<string> | undefined,
): Array<ReasoningEffort> {
  if (!values) return []

  const supported = new Set(
    values.filter((value): value is ReasoningEffort => isReasoningEffort(value)),
  )

  return REASONING_EFFORTS.filter((effort) => supported.has(effort))
}

export function deriveReasoningSupportByModel(
  details: Array<AdminModelDetailsItem>,
): Record<string, ReasoningSupportInfo> {
  const support: Record<string, ReasoningSupportInfo> = {}

  for (const model of details) {
    const efforts = normalizeReasoningSupport(
      model.capabilities?.supports?.reasoning_effort,
    )
    if (efforts.length === 0) continue

    support[model.id] = { efforts }
    for (const alias of model.aliases) {
      support[alias] = {
        efforts,
        target: model.id,
      }
    }
  }

  return support
}

function isPositiveInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0
}

export function compactThresholdRecordFromItems(
  items: Array<CompactThresholdItem>,
): Record<string, number> {
  const record: Record<string, number> = {}
  for (const item of items) {
    const key = item.model.trim()
    if (!key) continue
    const trimmed = item.threshold.trim()
    if (!trimmed) continue
    const value = Number(trimmed)
    if (!isPositiveInteger(value)) continue
    record[key] = value
  }
  return record
}

const BLOCKED_ALIAS_KEYS = new Set(["__proto__", "constructor", "prototype"])

function aliasRecordFromItems(items: Array<ModelAliasItem>): ModelAliasRecord {
  const record: ModelAliasRecord = Object.create(null) as ModelAliasRecord
  const seen = new Set<string>()

  for (const item of items) {
    const alias = item.alias.trim()
    const target = item.target.trim()
    if (!alias || !target) continue

    const normalizedAlias = alias.toLowerCase()
    if (BLOCKED_ALIAS_KEYS.has(normalizedAlias)) continue
    if (normalizedAlias === target.toLowerCase()) continue
    if (seen.has(normalizedAlias)) continue

    seen.add(normalizedAlias)
    record[alias] =
      item.allowOriginal === undefined
        ? { target }
        : { target, allowOriginal: item.allowOriginal }
  }

  return record
}

function modelMappingRecordFromItems(
  items: Array<ModelMappingItem>,
): Record<string, string> {
  const record: Record<string, string> = Object.create(null) as Record<string, string>
  const seen = new Set<string>()

  for (const item of items) {
    const source = item.source.trim()
    const target = item.target.trim()
    if (!source || !target) continue

    const normalizedSource = source.toLowerCase()
    if (BLOCKED_ALIAS_KEYS.has(normalizedSource)) continue
    if (seen.has(normalizedSource)) continue

    seen.add(normalizedSource)
    record[source] = target
  }

  return record
}

const BLOCKED_PROVIDER_KEYS = new Set(["__proto__", "constructor", "prototype"])

function normalizeProviderType(value: ProviderConfig["type"] | string | undefined): string {
  return value ?? "anthropic"
}

function isProviderType(value: string): value is ProviderType {
  return PROVIDER_TYPES.includes(value as ProviderType)
}

function normalizeProviderAuthType(
  value: ProviderConfig["authType"],
): ProviderAuthType {
  return value && PROVIDER_AUTH_TYPES.includes(value) ? value : "x-api-key"
}

function hasNonEmptyJsonText(value: string): boolean {
  const trimmed = value.trim()
  return Boolean(trimmed && trimmed !== "{}")
}

function stringifyOptionalJson(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2)
}

function createProviderItem(overrides: Partial<ProviderItem> = {}): ProviderItem {
  return {
    id: createItemId(),
    name: "",
    type: "anthropic",
    enabled: true,
    baseUrl: "",
    apiKey: "",
    authType: "x-api-key",
    pricingCurrency: "",
    adjustInputTokens: false,
    models: [],
    ...overrides,
  }
}

export function getUniqueProviderName(
  baseName: string,
  items: Array<{ name: string }>,
): string {
  const trimmedBaseName = baseName.trim()
  if (!trimmedBaseName) return ""

  const existingNames = new Set(
    items
      .map((item) => item.name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  )

  if (!existingNames.has(trimmedBaseName.toLowerCase())) {
    return trimmedBaseName
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${trimmedBaseName}-${index}`
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate
    }
  }
}

export function createQuickProviderItem(
  name: QuickProviderName,
  existingItems: Array<{ name: string }>,
): ProviderItem {
  const template = QUICK_PROVIDER_TEMPLATES[name]
  const providerName = getUniqueProviderName(template.name, existingItems)

  return createProviderItem({
    name: providerName,
    type: template.type,
    baseUrl: template.baseUrl,
    pricingCurrency: template.pricingCurrency,
  })
}

export function deriveProviderModelSuggestions(
  items: Array<{ name: string; models: Array<{ model: string }> }>,
  limit = 6,
): Array<string> {
  const suggestions: Array<string> = []
  const seen = new Set<string>()

  for (const provider of items) {
    const providerName = provider.name.trim()
    if (!providerName) continue

    for (const model of provider.models) {
      const modelName = model.model.trim()
      if (!modelName) continue

      const suggestion = `${providerName}/${modelName}`
      const normalized = suggestion.toLowerCase()
      if (seen.has(normalized)) continue

      seen.add(normalized)
      suggestions.push(suggestion)
      if (suggestions.length >= limit) return suggestions
    }
  }

  return suggestions
}

function providerItemsFromRecord(record: ProviderRecord | undefined): Array<ProviderItem> {
  if (!record) return []

  return Object.entries(record).map(([name, provider]) => ({
    id: createItemId(),
    name,
    type: normalizeProviderType(provider.type),
    enabled: provider.enabled ?? true,
    baseUrl: provider.baseUrl ?? "",
    apiKey: provider.apiKey ?? "",
    authType: normalizeProviderAuthType(provider.authType),
    pricingCurrency: provider.pricingCurrency ?? "",
    adjustInputTokens: provider.adjustInputTokens ?? false,
    models: Object.entries(provider.models ?? {}).map(([model, config]) => ({
      id: createItemId(),
      model,
      temperature: config.temperature === undefined ? "" : String(config.temperature),
      topP: config.topP === undefined ? "" : String(config.topP),
      topK: config.topK === undefined ? "" : String(config.topK),
      modelType: config.type ?? "inherit",
      modelTypeConfigured: Object.hasOwn(config, "type"),
      contextCache: config.contextCache ?? false,
      contextCacheConfigured: Object.hasOwn(config, "contextCache"),
      supportPdf: config.supportPdf ?? false,
      supportPdfConfigured: Object.hasOwn(config, "supportPdf"),
      toolContentSupportType: config.toolContentSupportType ?? [],
      pricingJson: stringifyOptionalJson(config.pricing),
      extraBodyJson: stringifyOptionalJson(config.extraBody),
    })),
  }))
}

function providerHasMeaningfulContent(item: ProviderItem): boolean {
  if (item.enabled === false) return true
  if (item.type !== "anthropic") return true
  if (item.baseUrl.trim() || item.apiKey.trim() || item.pricingCurrency.trim()) {
    return true
  }
  if (item.authType !== "x-api-key" || item.adjustInputTokens) return true

  return item.models.some(
    (model) =>
      Boolean(model.model.trim())
      || Boolean(model.temperature.trim())
      || Boolean(model.topP.trim())
      || Boolean(model.topK.trim())
      || model.modelTypeConfigured
      || model.contextCacheConfigured
      || model.supportPdfConfigured
      || model.toolContentSupportType.length > 0
      || hasNonEmptyJsonText(model.pricingJson)
      || hasNonEmptyJsonText(model.extraBodyJson),
  )
}

type ParsedProviderModelItem =
  | {
      modelId: string
      config: ProviderModelConfig
    }
  | null

type PricingNumberField = (typeof TOKEN_USAGE_PRICING_NUMBER_FIELDS)[number]

function isJsonCompatibleValue(value: unknown): boolean {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return typeof value !== "number" || Number.isFinite(value)
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonCompatibleValue(item))
  }

  if (!isPlainObject(value)) return false

  return Object.values(value).every((item) => isJsonCompatibleValue(item))
}

function parseOptionalPlainObjectJson(
  value: string,
  field: string,
): ParseResult<Record<string, unknown> | undefined> {
  const trimmed = value.trim()
  if (!trimmed || trimmed === "{}") return { record: undefined }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isPlainObject(parsed)) {
      return { error: `${field} must be a JSON object.` }
    }
    for (const key of Object.keys(parsed)) {
      if (BLOCKED_PROVIDER_KEYS.has(key)) {
        return { error: `${field}.${key} is not allowed.` }
      }
    }
    if (!isJsonCompatibleValue(parsed)) {
      return { error: `${field} must contain JSON-compatible values.` }
    }
    return { record: parsed }
  } catch {
    return { error: `${field} JSON is not valid.` }
  }
}

function assignPricingNumber(
  pricing: TokenUsagePricingTier,
  key: PricingNumberField,
  value: number,
): void {
  pricing[key] = value
}

function parsePricingTierObject(
  value: unknown,
  field: string,
  allowTiers: boolean,
): ParseResult<TokenUsagePricingTier> {
  if (!isPlainObject(value)) {
    return { error: `${field} must be a JSON object.` }
  }

  for (const key of Object.keys(value)) {
    if (BLOCKED_PROVIDER_KEYS.has(key)) {
      return { error: `${field}.${key} is not allowed.` }
    }
    if (!TOKEN_USAGE_PRICING_KEYS.has(key)) {
      return { error: `${field}.${key} is not supported.` }
    }
    if (key === "tiers" && !allowTiers) {
      return { error: `${field}.tiers is not supported.` }
    }
  }

  const pricing: TokenUsagePricingTier = {}
  for (const key of TOKEN_USAGE_PRICING_NUMBER_FIELDS) {
    if (!Object.hasOwn(value, key)) continue

    const raw = value[key]
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return { error: `${field}.${key} must be a non-negative number.` }
    }
    assignPricingNumber(pricing, key, raw)
  }

  return { record: pricing }
}

function parseOptionalPricingJson(
  value: string,
  field: string,
): ParseResult<TokenUsagePricingConfig | undefined> {
  const trimmed = value.trim()
  if (!trimmed || trimmed === "{}") return { record: undefined }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    const base = parsePricingTierObject(parsed, field, true)
    if ("error" in base) return base

    const pricing: TokenUsagePricingConfig = { ...base.record }
    if (!isPlainObject(parsed) || !Object.hasOwn(parsed, "tiers")) {
      return {
        record: Object.keys(pricing).length > 0 ? pricing : undefined,
      }
    }

    const rawTiers = parsed.tiers
    if (rawTiers === null || rawTiers === undefined) {
      return {
        record: Object.keys(pricing).length > 0 ? pricing : undefined,
      }
    }
    if (!Array.isArray(rawTiers)) {
      return { error: `${field}.tiers must be an array.` }
    }

    const tiers: Array<TokenUsagePricingTier> = []
    for (const [index, rawTier] of rawTiers.entries()) {
      const tier = parsePricingTierObject(
        rawTier,
        `${field}.tiers[${index}]`,
        false,
      )
      if ("error" in tier) return tier
      tiers.push(tier.record)
    }
    if (tiers.length > 0) pricing.tiers = tiers

    return {
      record: Object.keys(pricing).length > 0 ? pricing : undefined,
    }
  } catch {
    return { error: `${field} JSON is not valid.` }
  }
}

function parseSingleModelItem(
  modelItem: ProviderModelItem,
  providerName: string,
  seenModels: Set<string>,
): ParseResult<ParsedProviderModelItem> {
  const modelId = modelItem.model.trim()
  const temperatureInput = modelItem.temperature.trim()
  const topPInput = modelItem.topP.trim()
  const topKInput = modelItem.topK.trim()
  const modelTypeInput = modelItem.modelType.trim()
  const pricing = parseOptionalPricingJson(
    modelItem.pricingJson,
    `Provider '${providerName}' model pricing`,
  )
  if ("error" in pricing) return pricing

  const extraBody = parseOptionalPlainObjectJson(
    modelItem.extraBodyJson,
    `Provider '${providerName}' model extraBody`,
  )
  if ("error" in extraBody) return extraBody

  const hasNumericOverride = Boolean(temperatureInput || topPInput || topKInput)
  const hasAdvancedOverride = Boolean(
    modelItem.modelTypeConfigured
    || modelItem.contextCacheConfigured
    || modelItem.supportPdfConfigured
    || modelItem.toolContentSupportType.length > 0
    || pricing.record
    || extraBody.record,
  )

  if (!modelId) {
    if (hasNumericOverride || hasAdvancedOverride) {
      return {
        error: `Provider '${providerName}': model id is required when setting overrides.`,
      }
    }
    return { record: null }
  }

  const normalizedModelId = modelId.toLowerCase()
  if (BLOCKED_PROVIDER_KEYS.has(normalizedModelId)) {
    return { error: `Provider '${providerName}' model '${modelId}' is not allowed.` }
  }
  if (seenModels.has(normalizedModelId)) {
    return { error: `Provider '${providerName}' model '${modelId}' is duplicated.` }
  }

  const config: ProviderModelConfig = {}

  if (temperatureInput) {
    const parsed = Number(temperatureInput)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        error: `Provider '${providerName}' model '${modelId}': temperature must be a non-negative number.`,
      }
    }
    config.temperature = parsed
  }

  if (topPInput) {
    const parsed = Number(topPInput)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        error: `Provider '${providerName}' model '${modelId}': topP must be a non-negative number.`,
      }
    }
    config.topP = parsed
  }

  if (topKInput) {
    const parsed = Number(topKInput)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        error: `Provider '${providerName}' model '${modelId}': topK must be a non-negative number.`,
      }
    }
    config.topK = parsed
  }

  if (modelItem.modelTypeConfigured) {
    if (!isProviderType(modelTypeInput)) {
      return {
        error: `Provider '${providerName}' model '${modelId}': type must be one of: ${PROVIDER_TYPES.join(", ")}.`,
      }
    }
    config.type = modelTypeInput
  }

  if (modelItem.contextCacheConfigured) {
    config.contextCache = modelItem.contextCache
  }
  if (modelItem.supportPdfConfigured) {
    config.supportPdf = modelItem.supportPdf
  }
  if (modelItem.toolContentSupportType.length > 0) {
    config.toolContentSupportType = modelItem.toolContentSupportType
  }
  if (pricing.record) config.pricing = pricing.record
  if (extraBody.record) config.extraBody = extraBody.record

  if (Object.keys(config).length === 0) {
    return { record: null }
  }

  seenModels.add(normalizedModelId)
  return { record: { modelId, config } }
}

function parseProviderModelItems(
  items: Array<ProviderModelItem>,
  providerName: string,
): ParseResult<Record<string, ProviderModelConfig>> {
  const modelsRecord = Object.create(null) as Record<string, ProviderModelConfig>
  const seenModels = new Set<string>()

  for (const modelItem of items) {
    const result = parseSingleModelItem(modelItem, providerName, seenModels)
    if ("error" in result) return result
    if (!result.record) continue
    modelsRecord[result.record.modelId] = result.record.config
  }

  return { record: modelsRecord }
}

function providerRecordFromItems(items: Array<ProviderItem>): ParseResult<ProviderRecord> {
  const record: ProviderRecord = Object.create(null) as ProviderRecord
  const seenProviders = new Set<string>()

  for (const item of items) {
    const providerName = item.name.trim()
    if (!providerName) {
      if (providerHasMeaningfulContent(item)) {
        return { error: "Provider name is required." }
      }
      continue
    }

    const normalizedProviderName = providerName.toLowerCase()
    if (BLOCKED_PROVIDER_KEYS.has(normalizedProviderName)) {
      return { error: `Provider '${providerName}' is not allowed.` }
    }
    if (seenProviders.has(normalizedProviderName)) {
      return { error: `Provider '${providerName}' is duplicated.` }
    }

    seenProviders.add(normalizedProviderName)

    const providerType = item.type.trim() || "anthropic"
    if (!isProviderType(providerType)) {
      return {
        error: `Provider '${providerName}' type must be one of: ${PROVIDER_TYPES.join(", ")}.`,
      }
    }

    const baseUrl = item.baseUrl.trim()
    const apiKey = item.apiKey.trim()
    const pricingCurrency = item.pricingCurrency.trim()

    const provider: ProviderConfig = {
      type: providerType,
      enabled: item.enabled,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      authType: item.authType,
      pricingCurrency: pricingCurrency || undefined,
      adjustInputTokens: item.adjustInputTokens,
    }

    const modelItemsResult = parseProviderModelItems(item.models, providerName)
    if ("error" in modelItemsResult) return modelItemsResult

    if (Object.keys(modelItemsResult.record).length > 0) {
      provider.models = modelItemsResult.record
    }

    record[providerName] = provider
  }

  return { record }
}

type ProvidersEditor = {
  items: Array<ProviderItem>
  issue: string | null
  onAddProvider: () => void
  onQuickAddProvider: (name: QuickProviderName) => void
  onRemoveProvider: (id: string) => void
  onUpdateProvider: (id: string, patch: Partial<ProviderItem>) => void
  onAddModel: (providerId: string) => void
  onRemoveModel: (providerId: string, modelItemId: string) => void
  onUpdateModel: (
    providerId: string,
    modelItemId: string,
    patch: Partial<ProviderModelItem>,
  ) => void
  setFromRecord: (record?: ProviderRecord) => void
}

function useProvidersEditor(
  onRecordChange: (record: ProviderRecord) => void,
): ProvidersEditor {
  const [items, setItems] = useState<Array<ProviderItem>>([])
  const [issue, setIssue] = useState<string | null>(null)

  const setFromRecord = useCallback((record?: ProviderRecord) => {
    const nextItems = providerItemsFromRecord(record)
    const result = providerRecordFromItems(nextItems)
    setItems(nextItems)
    setIssue("error" in result ? result.error : null)
  }, [])

  const updateItems = useCallback(
    (nextItems: Array<ProviderItem>) => {
      setItems(nextItems)
      const result = providerRecordFromItems(nextItems)
      if ("error" in result) {
        setIssue(result.error)
        return
      }
      setIssue(null)
      onRecordChange(result.record)
    },
    [onRecordChange],
  )

  const onAddProvider = useCallback(() => {
    updateItems(items.concat(createProviderItem()))
  }, [items, updateItems])

  const onQuickAddProvider = useCallback(
    (name: QuickProviderName) => {
      updateItems(items.concat(createQuickProviderItem(name, items)))
    },
    [items, updateItems],
  )

  const onRemoveProvider = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateProvider = useCallback(
    (id: string, patch: Partial<ProviderItem>) => {
      const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
      updateItems(next)
    },
    [items, updateItems],
  )

  const onAddModel = useCallback(
    (providerId: string) => {
      const next = items.map((provider) => {
        if (provider.id !== providerId) return provider
        return {
          ...provider,
          models: provider.models.concat({
            id: createItemId(),
            model: "",
            temperature: "",
            topP: "",
            topK: "",
            modelType: "inherit",
            modelTypeConfigured: false,
            contextCache: false,
            contextCacheConfigured: false,
            supportPdf: false,
            supportPdfConfigured: false,
            toolContentSupportType: [],
            pricingJson: "",
            extraBodyJson: "",
          }),
        }
      })
      updateItems(next)
    },
    [items, updateItems],
  )

  const onRemoveModel = useCallback(
    (providerId: string, modelItemId: string) => {
      const next = items.map((provider) => {
        if (provider.id !== providerId) return provider
        return {
          ...provider,
          models: provider.models.filter((model) => model.id !== modelItemId),
        }
      })
      updateItems(next)
    },
    [items, updateItems],
  )

  const onUpdateModel = useCallback(
    (
      providerId: string,
      modelItemId: string,
      patch: Partial<ProviderModelItem>,
    ) => {
      const next = items.map((provider) => {
        if (provider.id !== providerId) return provider
        return {
          ...provider,
          models: provider.models.map((model) =>
            model.id === modelItemId ? { ...model, ...patch } : model,
          ),
        }
      })
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    items,
    issue,
    onAddProvider,
    onQuickAddProvider,
    onRemoveProvider,
    onUpdateProvider,
    onAddModel,
    onRemoveModel,
    onUpdateModel,
    setFromRecord,
  }
}

function parseExtraPromptsJson(
  value: string,
): ParseResult<Record<string, string>> {
  if (!value.trim()) return { record: {} }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return { error: "extraPrompts JSON must be an object of string values." }
    }

    const record: Record<string, string> = {}
    for (const [key, prompt] of Object.entries(parsed)) {
      if (typeof prompt !== "string") {
        return { error: `extraPrompts.${key} must be a string.` }
      }
      record[key] = prompt
    }

    return { record }
  } catch {
    return { error: "extraPrompts JSON is not valid." }
  }
}

export function parseReasoningJson(
  value: string,
): ParseResult<Record<string, ReasoningEffort>> {
  if (!value.trim()) return { record: {} }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return { error: "modelReasoningEfforts JSON must be an object." }
    }

    const record: Record<string, ReasoningEffort> = {}
    for (const [key, effort] of Object.entries(parsed)) {
      if (typeof effort !== "string") {
        return { error: `modelReasoningEfforts.${key} must be a string.` }
      }
      if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
        return {
          error: `modelReasoningEfforts.${key} must be one of ${REASONING_EFFORTS.join(", ")}.`,
        }
      }
      record[key] = effort as ReasoningEffort
    }

    return { record }
  } catch {
    return { error: "modelReasoningEfforts JSON is not valid." }
  }
}

export function parseCompactThresholdsJson(
  value: string,
): ParseResult<Record<string, number>> {
  if (!value.trim()) return { record: {} }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return {
        error: "modelResponsesApiCompactThresholds JSON must be an object.",
      }
    }

    const record: Record<string, number> = {}
    for (const [key, threshold] of Object.entries(parsed)) {
      if (typeof threshold !== "number") {
        return {
          error: `modelResponsesApiCompactThresholds.${key} must be a number.`,
        }
      }
      if (!isPositiveInteger(threshold)) {
        return {
          error: `modelResponsesApiCompactThresholds.${key} must be a positive integer.`,
        }
      }
      record[key] = threshold
    }

    return { record }
  } catch {
    return { error: "modelResponsesApiCompactThresholds JSON is not valid." }
  }
}

function parseModelAliasesJson(
  value: string,
): ParseResult<ModelAliasRecord> {
  if (!value.trim()) return { record: {} }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return { error: "modelAliases JSON must be an object." }
    }

    const record: ModelAliasRecord = Object.create(null) as ModelAliasRecord
    const seen = new Set<string>()

    for (const [rawAlias, rawTarget] of Object.entries(parsed)) {
      const alias = rawAlias.trim()
      if (!alias) {
        return { error: "modelAliases keys must be non-empty strings." }
      }

      const normalizedAlias = alias.toLowerCase()
      if (BLOCKED_ALIAS_KEYS.has(normalizedAlias)) {
        return { error: `modelAliases.${rawAlias} is not allowed.` }
      }

      let target: string | undefined
      let allowOriginal: boolean | undefined

      if (typeof rawTarget === "string") {
        target = rawTarget.trim()
      } else if (isPlainObject(rawTarget)) {
        const rawTargetValue = rawTarget.target
        if (typeof rawTargetValue !== "string") {
          return { error: `modelAliases.${rawAlias}.target must be a string.` }
        }
        target = rawTargetValue.trim()

        if ("allowOriginal" in rawTarget) {
          if (typeof rawTarget.allowOriginal !== "boolean") {
            return {
              error: `modelAliases.${rawAlias}.allowOriginal must be a boolean.`,
            }
          }
          allowOriginal = rawTarget.allowOriginal
        }
      } else {
        return { error: `modelAliases.${rawAlias} must be a string or object.` }
      }

      if (!target) {
        return { error: `modelAliases.${rawAlias} must be a non-empty string.` }
      }

      if (normalizedAlias === target.toLowerCase()) {
        return { error: `modelAliases.${rawAlias} cannot map to itself.` }
      }
      if (seen.has(normalizedAlias)) {
        return { error: `modelAliases.${rawAlias} conflicts with another alias.` }
      }

      seen.add(normalizedAlias)
      record[alias] =
        allowOriginal === undefined ? { target } : { target, allowOriginal }
    }

    return { record }
  } catch {
    return { error: "modelAliases JSON is not valid." }
  }
}

export function parseModelMappingsJson(
  value: string,
): ParseResult<Record<string, string>> {
  if (!value.trim()) return { record: {} }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return { error: "modelMappings JSON must be an object." }
    }

    const record: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >
    const seen = new Set<string>()

    for (const [rawSource, rawTarget] of Object.entries(parsed)) {
      const source = rawSource.trim()
      if (!source) {
        return { error: "modelMappings keys must be non-empty strings." }
      }

      const normalizedSource = source.toLowerCase()
      if (BLOCKED_ALIAS_KEYS.has(normalizedSource)) {
        return { error: `modelMappings.${rawSource} is not allowed.` }
      }
      if (seen.has(normalizedSource)) {
        return {
          error: `modelMappings.${rawSource} conflicts with another mapping.`,
        }
      }
      if (typeof rawTarget !== "string") {
        return { error: `modelMappings.${rawSource} must be a string.` }
      }

      const target = rawTarget.trim()
      if (!target) {
        return { error: `modelMappings.${rawSource} must be a non-empty string.` }
      }

      seen.add(normalizedSource)
      record[source] = target
    }

    return { record }
  } catch {
    return { error: "modelMappings JSON is not valid." }
  }
}

type ExtraPromptEditor = {
  mode: JsonMode
  items: Array<ExtraPromptItem>
  json: string
  jsonIssue: string | null
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ExtraPromptItem>) => void
  setFromRecord: (record?: Record<string, string>) => void
}

type ReasoningEditor = {
  mode: JsonMode
  items: Array<ReasoningItem>
  json: string
  jsonIssue: string | null
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ReasoningItem>) => void
  setFromRecord: (record?: Record<string, ReasoningEffort>) => void
}

type CompactThresholdEditor = {
  mode: JsonMode
  items: Array<CompactThresholdItem>
  json: string
  jsonIssue: string | null
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<CompactThresholdItem>) => void
  setFromRecord: (record?: Record<string, number>) => void
}

type ModelAliasEditor = {
  mode: JsonMode
  items: Array<ModelAliasItem>
  json: string
  jsonIssue: string | null
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
  setFromRecord: (record?: ModelAliasRecordInput) => void
}

type ModelMappingEditor = {
  mode: JsonMode
  items: Array<ModelMappingItem>
  json: string
  jsonIssue: string | null
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelMappingItem>) => void
  setFromRecord: (record?: Record<string, string>) => void
}

function useExtraPromptEditor(
  onRecordChange: (record: Record<string, string>) => void,
): ExtraPromptEditor {
  const [mode, setMode] = useState<JsonMode>("form")
  const [items, setItems] = useState<Array<ExtraPromptItem>>([])
  const [json, setJson] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const jsonIssue = useMemo(
    () => (jsonError ? `extraPrompts: ${jsonError}` : null),
    [jsonError],
  )

  const setFromRecord = useCallback((record?: Record<string, string>) => {
    setItems(extraPromptItemsFromRecord(record))
    setJson(JSON.stringify(record ?? {}, null, 2))
    setJsonError(null)
  }, [])

  const updateItems = useCallback(
    (nextItems: Array<ExtraPromptItem>) => {
      setItems(nextItems)
      onRecordChange(extraPromptRecordFromItems(nextItems))
    },
    [onRecordChange],
  )

  const onJsonChange = useCallback(
    (value: string) => {
      updateJsonRecord({
        value,
        parse: parseExtraPromptsJson,
        setJson,
        setError: setJsonError,
        onRecord: (record) => updateItems(extraPromptItemsFromRecord(record)),
      })
    },
    [updateItems],
  )

  const onToggleMode = useCallback(
    (next: boolean) => {
      toggleJsonMode({
        next,
        record: extraPromptRecordFromItems(items),
        setJson,
        setError: setJsonError,
        setMode,
      })
    },
    [items],
  )

  const onAddItem = useCallback(() => {
    updateItems(items.concat({ id: createItemId(), model: "", prompt: "" }))
  }, [items, updateItems])

  const onRemoveItem = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateItem = useCallback(
    (id: string, patch: Partial<ExtraPromptItem>) => {
      const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    mode,
    items,
    json,
    jsonIssue,
    onToggleMode,
    onJsonChange,
    onAddItem,
    onRemoveItem,
    onUpdateItem,
    setFromRecord,
  }
}

function useReasoningEditor(
  onRecordChange: (record: Record<string, ReasoningEffort>) => void,
): ReasoningEditor {
  const [mode, setMode] = useState<JsonMode>("form")
  const [items, setItems] = useState<Array<ReasoningItem>>([])
  const [json, setJson] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const jsonIssue = useMemo(
    () => (jsonError ? `modelReasoningEfforts: ${jsonError}` : null),
    [jsonError],
  )

  const setFromRecord = useCallback((record?: Record<string, ReasoningEffort>) => {
    setItems(reasoningItemsFromRecord(record))
    setJson(JSON.stringify(record ?? {}, null, 2))
    setJsonError(null)
  }, [])

  const updateItems = useCallback(
    (nextItems: Array<ReasoningItem>) => {
      setItems(nextItems)
      onRecordChange(reasoningRecordFromItems(nextItems))
    },
    [onRecordChange],
  )

  const onJsonChange = useCallback(
    (value: string) => {
      updateJsonRecord({
        value,
        parse: parseReasoningJson,
        setJson,
        setError: setJsonError,
        onRecord: (record) => updateItems(reasoningItemsFromRecord(record)),
      })
    },
    [updateItems],
  )

  const onToggleMode = useCallback(
    (next: boolean) => {
      toggleJsonMode({
        next,
        record: reasoningRecordFromItems(items),
        setJson,
        setError: setJsonError,
        setMode,
      })
    },
    [items],
  )

  const onAddItem = useCallback(() => {
    updateItems(items.concat({ id: createItemId(), model: "", effort: "high" }))
  }, [items, updateItems])

  const onRemoveItem = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateItem = useCallback(
    (id: string, patch: Partial<ReasoningItem>) => {
      const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    mode,
    items,
    json,
    jsonIssue,
    onToggleMode,
    onJsonChange,
    onAddItem,
    onRemoveItem,
    onUpdateItem,
    setFromRecord,
  }
}

function useCompactThresholdEditor(
  onRecordChange: (record: Record<string, number>) => void,
): CompactThresholdEditor {
  const [mode, setMode] = useState<JsonMode>("form")
  const [items, setItems] = useState<Array<CompactThresholdItem>>([])
  const [json, setJson] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const jsonIssue = useMemo(
    () =>
      jsonError ? `modelResponsesApiCompactThresholds: ${jsonError}` : null,
    [jsonError],
  )

  const setFromRecord = useCallback(
    (record?: Record<string, number>) => {
      setItems(compactThresholdItemsFromRecord(record))
      setJson(JSON.stringify(record ?? {}, null, 2))
      setJsonError(null)
    },
    [],
  )

  const updateItems = useCallback(
    (nextItems: Array<CompactThresholdItem>) => {
      setItems(nextItems)
      onRecordChange(compactThresholdRecordFromItems(nextItems))
    },
    [onRecordChange],
  )

  const onJsonChange = useCallback(
    (value: string) => {
      updateJsonRecord({
        value,
        parse: parseCompactThresholdsJson,
        setJson,
        setError: setJsonError,
        onRecord: (record) =>
          updateItems(compactThresholdItemsFromRecord(record)),
      })
    },
    [updateItems],
  )

  const onToggleMode = useCallback(
    (next: boolean) => {
      toggleJsonMode({
        next,
        record: compactThresholdRecordFromItems(items),
        setJson,
        setError: setJsonError,
        setMode,
      })
    },
    [items],
  )

  const onAddItem = useCallback(() => {
    updateItems(
      items.concat({ id: createItemId(), model: "", threshold: "" }),
    )
  }, [items, updateItems])

  const onRemoveItem = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateItem = useCallback(
    (id: string, patch: Partial<CompactThresholdItem>) => {
      const next = items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      )
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    mode,
    items,
    json,
    jsonIssue,
    onToggleMode,
    onJsonChange,
    onAddItem,
    onRemoveItem,
    onUpdateItem,
    setFromRecord,
  }
}

function useModelAliasEditor(
  onRecordChange: (record: ModelAliasRecord) => void,
): ModelAliasEditor {
  const [mode, setMode] = useState<JsonMode>("form")
  const [items, setItems] = useState<Array<ModelAliasItem>>([])
  const [json, setJson] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const jsonIssue = useMemo(
    () => (jsonError ? `modelAliases: ${jsonError}` : null),
    [jsonError],
  )

  const setFromRecord = useCallback((record?: ModelAliasRecordInput) => {
    const nextItems = aliasItemsFromRecord(record)
    const normalizedRecord = aliasRecordFromItems(nextItems)
    setItems(nextItems)
    setJson(JSON.stringify(normalizedRecord, null, 2))
    setJsonError(null)
  }, [])

  const updateItems = useCallback(
    (nextItems: Array<ModelAliasItem>) => {
      setItems(nextItems)
      onRecordChange(aliasRecordFromItems(nextItems))
    },
    [onRecordChange],
  )

  const onJsonChange = useCallback(
    (value: string) => {
      updateJsonRecord({
        value,
        parse: parseModelAliasesJson,
        setJson,
        setError: setJsonError,
        onRecord: (record) => updateItems(aliasItemsFromRecord(record)),
      })
    },
    [updateItems],
  )

  const onToggleMode = useCallback(
    (next: boolean) => {
      toggleJsonMode({
        next,
        record: aliasRecordFromItems(items),
        setJson,
        setError: setJsonError,
        setMode,
      })
    },
    [items],
  )

  const onAddItem = useCallback(() => {
    updateItems(
      items.concat({ id: createItemId(), alias: "", target: "", allowOriginal: undefined }),
    )
  }, [items, updateItems])

  const onRemoveItem = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateItem = useCallback(
    (id: string, patch: Partial<ModelAliasItem>) => {
      const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    mode,
    items,
    json,
    jsonIssue,
    onToggleMode,
    onJsonChange,
    onAddItem,
    onRemoveItem,
    onUpdateItem,
    setFromRecord,
  }
}

function useModelMappingEditor(
  onRecordChange: (record: Record<string, string>) => void,
): ModelMappingEditor {
  const [mode, setMode] = useState<JsonMode>("form")
  const [items, setItems] = useState<Array<ModelMappingItem>>([])
  const [json, setJson] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const jsonIssue = useMemo(
    () => (jsonError ? `modelMappings: ${jsonError}` : null),
    [jsonError],
  )

  const setFromRecord = useCallback((record?: Record<string, string>) => {
    const nextItems = modelMappingItemsFromRecord(record)
    const normalizedRecord = modelMappingRecordFromItems(nextItems)
    setItems(nextItems)
    setJson(JSON.stringify(normalizedRecord, null, 2))
    setJsonError(null)
  }, [])

  const updateItems = useCallback(
    (nextItems: Array<ModelMappingItem>) => {
      setItems(nextItems)
      onRecordChange(modelMappingRecordFromItems(nextItems))
    },
    [onRecordChange],
  )

  const onJsonChange = useCallback(
    (value: string) => {
      updateJsonRecord({
        value,
        parse: parseModelMappingsJson,
        setJson,
        setError: setJsonError,
        onRecord: (record) => updateItems(modelMappingItemsFromRecord(record)),
      })
    },
    [updateItems],
  )

  const onToggleMode = useCallback(
    (next: boolean) => {
      toggleJsonMode({
        next,
        record: modelMappingRecordFromItems(items),
        setJson,
        setError: setJsonError,
        setMode,
      })
    },
    [items],
  )

  const onAddItem = useCallback(() => {
    updateItems(items.concat({ id: createItemId(), source: "", target: "" }))
  }, [items, updateItems])

  const onRemoveItem = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateItem = useCallback(
    (id: string, patch: Partial<ModelMappingItem>) => {
      const next = items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      )
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    mode,
    items,
    json,
    jsonIssue,
    onToggleMode,
    onJsonChange,
    onAddItem,
    onRemoveItem,
    onUpdateItem,
    setFromRecord,
  }
}

type GeneralSettingsCardProps = {
  hasModels: boolean
  smallModelLabel: string
  smallModelValue: string
  smallModelInputValue: string
  models: Array<string>
  authApiKeysValue: string
  anthropicApiKeyValue: string
  legacyAuthNote: string
  anthropicApiKeyEnvNote: string
  onSmallModelSelect: (value: string) => void
  onSmallModelInput: (value: string) => void
  onAuthApiKeysChange: (value: string) => void
  onAnthropicApiKeyChange: (value: string) => void
}

function GeneralSettingsCard({
  hasModels,
  smallModelLabel,
  smallModelValue,
  smallModelInputValue,
  models,
  authApiKeysValue,
  anthropicApiKeyValue,
  legacyAuthNote,
  anthropicApiKeyEnvNote,
  onSmallModelSelect,
  onSmallModelInput,
  onAuthApiKeysChange,
  onAnthropicApiKeyChange,
}: GeneralSettingsCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [showAnthropicApiKey, setShowAnthropicApiKey] = useState(false)

  const showCustomModel =
    hasModels
    && smallModelValue !== "__default__"
    && !models.includes(smallModelValue)

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.general.title")}</CardTitle>
        <CardDescription className="hidden sm:block">{t("settingsPage.general.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">{smallModelLabel}</Label>
          {hasModels ? (
            <Select value={smallModelValue} onValueChange={onSmallModelSelect}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("settingsPage.general.smallModelPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{t("settingsPage.common.defaultOption")}</SelectItem>
                {showCustomModel ? (
                  <SelectItem value={smallModelValue}>
                    {t("settingsPage.common.customModel", { value: smallModelValue })}
                  </SelectItem>
                ) : null}
                {models.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder={t("settingsPage.general.smallModelInputPlaceholder")}
              value={smallModelInputValue}
              onChange={(e) => onSmallModelInput(e.target.value)}
            />
          )}
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.general.smallModelHint")}
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.general.apiKeysLabel")}
          </Label>
          <Textarea
            autoComplete="off"
            placeholder={t("settingsPage.general.apiKeysPlaceholder")}
            value={authApiKeysValue}
            onChange={(e) => onAuthApiKeysChange(e.target.value)}
            className="min-h-[96px] font-mono text-xs"
          />
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.general.apiKeysHint")}
          </div>
          <div className="text-muted-foreground text-xs">
            {legacyAuthNote}
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.general.anthropicApiKeyLabel")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              autoComplete="off"
              type={showAnthropicApiKey ? "text" : "password"}
              placeholder={t("settingsPage.general.anthropicApiKeyPlaceholder")}
              value={anthropicApiKeyValue}
              onChange={(e) => onAnthropicApiKeyChange(e.target.value)}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              onClick={() => setShowAnthropicApiKey((prev) => !prev)}
              aria-label={showAnthropicApiKey
                ? t("settingsPage.general.hideAnthropicApiKey")
                : t("settingsPage.general.showAnthropicApiKey")}
            >
              {showAnthropicApiKey ? <EyeOffIcon /> : <EyeIcon />}
              <span className="hidden sm:inline">
                {showAnthropicApiKey
                  ? t("settingsPage.general.hideAnthropicApiKey")
                  : t("settingsPage.general.showAnthropicApiKey")}
              </span>
            </Button>
          </div>
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.general.anthropicApiKeyHint")}
          </div>
          <div className="text-muted-foreground text-xs">
            {anthropicApiKeyEnvNote}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

type ReasoningEffortsCardProps = {
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<ReasoningItem>
  models: Array<string>
  reasoningSupportByModel?: Record<string, ReasoningSupportInfo>
  reasoningSupportLoaded?: boolean
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ReasoningItem>) => void
}

export function ReasoningEffortsCard({
  mode,
  json,
  jsonIssue,
  items,
  models,
  reasoningSupportByModel = {},
  reasoningSupportLoaded = true,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ReasoningEffortsCardProps): React.JSX.Element {
  const defaultModelValue = "__default__"
  const hasModels = models.length > 0
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.reasoning.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.reasoning.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.reasoning.hint")}
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
            <Label className="text-muted-foreground text-xs">{t("settingsPage.common.jsonMode")}</Label>
          </div>
        </div>

        {mode === "json" ? (
          <div className="space-y-2">
            <Textarea
              value={json}
              onChange={(e) => onJsonChange(e.target.value)}
              className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
              placeholder={t("settingsPage.reasoning.jsonPlaceholder")}
            />
            {jsonIssue ? (
              <InlineAlert variant="warning" title={t("settingsPage.common.invalidJsonTitle")} description={jsonIssue} />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                {t("settingsPage.reasoning.emptyState")}
              </div>
            ) : (
              items.map((item) => {
                const modelValue = item.model || defaultModelValue
                const isDefaultModel = modelValue === defaultModelValue
                const showCustomModel =
                  !isDefaultModel && !models.includes(modelValue)
                const disableModelSelect = !hasModels && !showCustomModel
                const supportInfo =
                  !isDefaultModel ? reasoningSupportByModel[modelValue] : undefined
                const supportEfforts = supportInfo?.efforts ?? []
                const hasSupportEfforts = supportEfforts.length > 0
                const supportMissingForModel =
                  reasoningSupportLoaded && !isDefaultModel && !hasSupportEfforts
                const supportedEfforts =
                  hasSupportEfforts
                    ? supportEfforts
                    : supportMissingForModel
                      ? [item.effort]
                      : REASONING_EFFORTS
                const showUnsupportedConfiguredEffort =
                  hasSupportEfforts && !supportEfforts.includes(item.effort)
                const effortOptions =
                  showUnsupportedConfiguredEffort
                    ? [item.effort, ...supportedEfforts]
                    : supportedEfforts

                return (
                  <div
                    key={item.id}
                    className="grid gap-2 rounded-lg border p-3"
                    data-reasoning-model={modelValue}
                    data-reasoning-target={supportInfo?.target}
                    data-reasoning-effort-options={effortOptions.join(",")}
                    data-reasoning-effort-disabled={
                      supportMissingForModel ? "true" : undefined
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={modelValue}
                        onValueChange={(value) =>
                          onUpdateItem(item.id, {
                            model: value === defaultModelValue ? "" : value,
                          })
                        }
                        disabled={disableModelSelect}
                      >
                        <SelectTrigger className="min-w-[220px]">
                          <SelectValue
                            placeholder={
                              hasModels
                                ? t("settingsPage.common.selectModelPlaceholder")
                                : t("settingsPage.common.noModelsAvailable")
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={defaultModelValue}>
                            {t("settingsPage.common.defaultOption")}
                          </SelectItem>
                          {showCustomModel ? (
                            <SelectItem value={modelValue}>
                              {t("settingsPage.common.customModel", { value: modelValue })}
                            </SelectItem>
                          ) : null}
                          {models.map((model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={item.effort}
                        onValueChange={(value) =>
                          onUpdateItem(item.id, { effort: value as ReasoningEffort })
                        }
                        disabled={supportMissingForModel}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {effortOptions.map((effort) => (
                            <SelectItem key={effort} value={effort}>
                              {effort}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRemoveItem(item.id)}
                      >
                        {t("settingsPage.common.remove")}
                      </Button>
                    </div>
                    {supportInfo?.target ? (
                      <div className="text-muted-foreground text-xs">
                        {t("settingsPage.reasoning.aliasSupportHint", {
                          target: supportInfo.target,
                        })}
                      </div>
                    ) : null}
                    {supportMissingForModel ? (
                      <InlineAlert
                        variant="warning"
                        title={t("settingsPage.reasoning.noMetadataTitle")}
                        description={t(
                          "settingsPage.reasoning.noMetadataDescription",
                        )}
                      />
                    ) : null}
                    {showUnsupportedConfiguredEffort ? (
                      <InlineAlert
                        variant="warning"
                        title={t("settingsPage.reasoning.unsupportedEffortTitle")}
                        description={t(
                          "settingsPage.reasoning.unsupportedEffortDescription",
                          { effort: item.effort },
                        )}
                      />
                    ) : null}
                    <div className="text-muted-foreground text-xs">
                      {t("settingsPage.reasoning.itemHint")}
                    </div>
                  </div>
                )
              })
            )}

            <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
              {t("settingsPage.reasoning.addButton")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type CompactThresholdsCardProps = {
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<CompactThresholdItem>
  models: Array<string>
  contextManagementEnabled?: boolean
  embedded?: boolean
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<CompactThresholdItem>) => void
}

function CompactThresholdsCard({
  mode,
  json,
  jsonIssue,
  items,
  models,
  contextManagementEnabled = true,
  embedded = false,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: CompactThresholdsCardProps): React.JSX.Element {
  const defaultModelValue = "__default__"
  const hasModels = models.length > 0
  const { t } = useTranslation()

  const formBody = (
    <div className="space-y-2">
      {items.length === 0 ? (
        <div className="text-muted-foreground text-sm">
          {t("settingsPage.compactThresholds.emptyState")}
        </div>
      ) : (
        items.map((item) => {
          const modelValue = item.model || defaultModelValue
          const showCustomModel =
            modelValue !== defaultModelValue
            && !models.includes(modelValue)
          const disableModelSelect = !hasModels && !showCustomModel
          const trimmed = item.threshold.trim()
          const numericValue = trimmed === "" ? NaN : Number(trimmed)
          const itemInvalid = trimmed !== "" && !isPositiveInteger(numericValue)

          return (
            <div
              key={item.id}
              className="grid gap-2 rounded-lg border p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={modelValue}
                  onValueChange={(value) =>
                    onUpdateItem(item.id, {
                      model: value === defaultModelValue ? "" : value,
                    })
                  }
                  disabled={disableModelSelect}
                >
                  <SelectTrigger className="min-w-[220px]">
                    <SelectValue
                      placeholder={
                        hasModels
                          ? t("settingsPage.common.selectModelPlaceholder")
                          : t("settingsPage.common.noModelsAvailable")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={defaultModelValue}>
                      {t("settingsPage.common.defaultOption")}
                    </SelectItem>
                    {showCustomModel ? (
                      <SelectItem value={modelValue}>
                        {t("settingsPage.common.customModel", {
                          value: modelValue,
                        })}
                      </SelectItem>
                    ) : null}
                    {models.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  className="w-40"
                  value={item.threshold}
                  placeholder={t(
                    "settingsPage.compactThresholds.thresholdPlaceholder",
                  )}
                  onChange={(e) =>
                    onUpdateItem(item.id, { threshold: e.target.value })
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onRemoveItem(item.id)}
                >
                  {t("settingsPage.common.remove")}
                </Button>
              </div>
              {itemInvalid ? (
                <div className="text-destructive text-xs">
                  {t("settingsPage.compactThresholds.itemInvalid")}
                </div>
              ) : (
                <div className="text-muted-foreground text-xs">
                  {t("settingsPage.compactThresholds.itemHint")}
                </div>
              )}
            </div>
          )
        })
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAddItem}
      >
        {t("settingsPage.compactThresholds.addButton")}
      </Button>
    </div>
  )

  const content = (
    <>
      {!contextManagementEnabled ? (
        <InlineAlert
          variant="warning"
          title={t("settingsPage.responsesApi.contextManagementInactiveTitle")}
          description={t(
            "settingsPage.responsesApi.compactThresholdsInactiveHint",
          )}
        />
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <div className="text-muted-foreground text-xs">
          {t("settingsPage.compactThresholds.hint")}
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.common.jsonMode")}
          </Label>
        </div>
      </div>

      {mode === "json" ? (
        <div className="space-y-2">
          <Textarea
            value={json}
            onChange={(e) => onJsonChange(e.target.value)}
            className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
            placeholder={t("settingsPage.compactThresholds.jsonPlaceholder")}
          />
          {jsonIssue ? (
            <InlineAlert
              variant="warning"
              title={t("settingsPage.common.invalidJsonTitle")}
              description={jsonIssue}
            />
          ) : null}
        </div>
      ) : (
        formBody
      )}
    </>
  )

  if (embedded) {
    return <div className="space-y-3">{content}</div>
  }

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.compactThresholds.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.compactThresholds.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">{content}</CardContent>
    </Card>
  )
}

type ExtraPromptsCardProps = {
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<ExtraPromptItem>
  models: Array<string>
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ExtraPromptItem>) => void
}

function ExtraPromptsCard({
  mode,
  json,
  jsonIssue,
  items,
  models,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ExtraPromptsCardProps): React.JSX.Element {
  const defaultModelValue = "__default__"
  const hasModels = models.length > 0
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.prompts.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.prompts.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.prompts.hint")}
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
            <Label className="text-muted-foreground text-xs">{t("settingsPage.common.jsonMode")}</Label>
          </div>
        </div>

        {mode === "json" ? (
          <div className="space-y-2">
            <Textarea
              value={json}
              onChange={(e) => onJsonChange(e.target.value)}
              className="min-h-[200px] lg:min-h-[140px] max-h-[40vh] overflow-auto font-mono text-xs"
              placeholder={t("settingsPage.prompts.jsonPlaceholder")}
            />
            {jsonIssue ? (
              <InlineAlert variant="warning" title={t("settingsPage.common.invalidJsonTitle")} description={jsonIssue} />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-muted-foreground text-sm">{t("settingsPage.prompts.emptyState")}</div>
            ) : (
              items.map((item) => {
                const modelValue = item.model || defaultModelValue
                const showCustomModel =
                  modelValue !== defaultModelValue && !models.includes(modelValue)
                const disableModelSelect = !hasModels && !showCustomModel

                return (
                  <div key={item.id} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={modelValue}
                        onValueChange={(value) =>
                          onUpdateItem(item.id, {
                            model: value === defaultModelValue ? "" : value,
                          })
                        }
                        disabled={disableModelSelect}
                      >
                        <SelectTrigger className="min-w-[220px]">
                          <SelectValue
                            placeholder={
                              hasModels
                                ? t("settingsPage.common.selectModelPlaceholder")
                                : t("settingsPage.common.noModelsAvailable")
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={defaultModelValue}>
                            {t("settingsPage.common.defaultOption")}
                          </SelectItem>
                          {showCustomModel ? (
                            <SelectItem value={modelValue}>
                              {t("settingsPage.common.customModel", { value: modelValue })}
                            </SelectItem>
                          ) : null}
                          {models.map((model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRemoveItem(item.id)}
                      >
                        {t("settingsPage.common.remove")}
                      </Button>
                    </div>
                    <Textarea
                      value={item.prompt}
                      onChange={(e) => onUpdateItem(item.id, { prompt: e.target.value })}
                      className="min-h-[120px] lg:min-h-[96px] max-h-[30vh] overflow-auto font-mono text-xs"
                      placeholder={t("settingsPage.prompts.promptPlaceholder")}
                    />
                    <div className="text-muted-foreground text-xs">
                      {t("settingsPage.prompts.itemHint")}
                    </div>
                  </div>
                )
              })
            )}

            <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
              {t("settingsPage.prompts.addButton")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type ModelAliasesCardProps = {
  allowOriginalModelNamesForAliases: boolean
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<ModelAliasItem>
  models: Array<string>
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
}

type ModelAliasesHeaderProps = {
  allowOriginalModelNamesForAliases: boolean
  mode: JsonMode
  onToggleMode: (next: boolean) => void
}

type ModelAliasesJsonEditorProps = {
  json: string
  jsonIssue: string | null
  onJsonChange: (value: string) => void
}

type ModelAliasItemCardProps = {
  item: ModelAliasItem
  models: Array<string>
  emptyTargetValue: string
  allowOriginalDefaultValue: string
  hasModels: boolean
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
  onRemoveItem: (id: string) => void
}

type ModelAliasesListProps = {
  items: Array<ModelAliasItem>
  models: Array<string>
  emptyTargetValue: string
  allowOriginalDefaultValue: string
  hasModels: boolean
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
}

function ModelAliasesHeader({
  allowOriginalModelNamesForAliases,
  mode,
  onToggleMode,
}: ModelAliasesHeaderProps): React.JSX.Element {
  const { t } = useTranslation()

  const defaultBehavior = allowOriginalModelNamesForAliases
    ? t("settingsPage.common.allow")
    : t("settingsPage.common.block")

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-muted-foreground text-xs">
        {t("settingsPage.aliases.defaultBehaviorHint", { behavior: defaultBehavior })}
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
        <Label className="text-muted-foreground text-xs">{t("settingsPage.common.jsonMode")}</Label>
      </div>
    </div>
  )
}

function ModelAliasesJsonEditor({
  json,
  jsonIssue,
  onJsonChange,
}: ModelAliasesJsonEditorProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      <Textarea
        value={json}
        onChange={(e) => onJsonChange(e.target.value)}
        className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
        placeholder={t("settingsPage.aliases.jsonPlaceholder")}
      />
      {jsonIssue ? (
        <InlineAlert
          variant="warning"
          title={t("settingsPage.common.invalidJsonTitle")}
          description={jsonIssue}
        />
      ) : null}
    </div>
  )
}

function ModelAliasItemCard({
  item,
  models,
  emptyTargetValue,
  allowOriginalDefaultValue,
  hasModels,
  onUpdateItem,
  onRemoveItem,
}: ModelAliasItemCardProps): React.JSX.Element {
  const { t } = useTranslation()

  const targetValue = item.target || emptyTargetValue
  const showCustomTarget = targetValue !== emptyTargetValue && !models.includes(targetValue)
  const disableTargetSelect = !hasModels && !showCustomTarget
  const allowOriginalValue =
    item.allowOriginal === undefined
      ? allowOriginalDefaultValue
      : item.allowOriginal
        ? "allow"
        : "block"

  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[180px]"
          placeholder={t("settingsPage.aliases.aliasPlaceholder")}
          value={item.alias}
          onChange={(e) => onUpdateItem(item.id, { alias: e.target.value })}
        />
        <Select
          value={targetValue}
          onValueChange={(value) =>
            onUpdateItem(item.id, {
              target: value === emptyTargetValue ? "" : value,
            })
          }
          disabled={disableTargetSelect}
        >
          <SelectTrigger className="min-w-[220px]">
            <SelectValue
              placeholder={
                hasModels
                  ? t("settingsPage.aliases.selectTargetPlaceholder")
                  : t("settingsPage.common.noModelsAvailable")
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={emptyTargetValue}>{t("settingsPage.aliases.selectOption")}</SelectItem>
            {showCustomTarget ? (
              <SelectItem value={targetValue}>
                {t("settingsPage.common.customModel", { value: targetValue })}
              </SelectItem>
            ) : null}
            {models.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={allowOriginalValue}
          onValueChange={(value) =>
            onUpdateItem(item.id, {
              allowOriginal:
                value === allowOriginalDefaultValue
                  ? undefined
                  : value === "allow",
            })
          }
        >
          <SelectTrigger className="min-w-[200px]">
            <SelectValue placeholder={t("settingsPage.aliases.originalModelPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={allowOriginalDefaultValue}>{t("settingsPage.aliases.useDefault")}</SelectItem>
            <SelectItem value="allow">{t("settingsPage.aliases.allowOriginal")}</SelectItem>
            <SelectItem value="block">{t("settingsPage.aliases.blockOriginal")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRemoveItem(item.id)}
        >
          {t("settingsPage.common.remove")}
        </Button>
      </div>
    </div>
  )
}

function ModelAliasesList({
  items,
  models,
  emptyTargetValue,
  allowOriginalDefaultValue,
  hasModels,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ModelAliasesListProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <div className="text-muted-foreground text-sm">{t("settingsPage.aliases.emptyState")}</div>
      ) : (
        items.map((item) => (
          <ModelAliasItemCard
            key={item.id}
            item={item}
            models={models}
            emptyTargetValue={emptyTargetValue}
            allowOriginalDefaultValue={allowOriginalDefaultValue}
            hasModels={hasModels}
            onUpdateItem={onUpdateItem}
            onRemoveItem={onRemoveItem}
          />
        ))
      )}

      <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
        {t("settingsPage.aliases.addButton")}
      </Button>
    </div>
  )
}

function ModelAliasesCard({
  allowOriginalModelNamesForAliases,
  mode,
  json,
  jsonIssue,
  items,
  models,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ModelAliasesCardProps): React.JSX.Element {
  const emptyTargetValue = "__target__"
  const allowOriginalDefaultValue = "__allow_original_default__"
  const hasModels = models.length > 0
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.aliases.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.aliases.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <ModelAliasesHeader
          allowOriginalModelNamesForAliases={allowOriginalModelNamesForAliases}
          mode={mode}
          onToggleMode={onToggleMode}
        />

        {mode === "json" ? (
          <ModelAliasesJsonEditor
            json={json}
            jsonIssue={jsonIssue}
            onJsonChange={onJsonChange}
          />
        ) : (
          <ModelAliasesList
            items={items}
            models={models}
            emptyTargetValue={emptyTargetValue}
            allowOriginalDefaultValue={allowOriginalDefaultValue}
            hasModels={hasModels}
            onAddItem={onAddItem}
            onRemoveItem={onRemoveItem}
            onUpdateItem={onUpdateItem}
          />
        )}
      </CardContent>
    </Card>
  )
}

type ModelMappingsCardProps = {
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<ModelMappingItem>
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelMappingItem>) => void
}

export function ModelMappingsCard({
  mode,
  json,
  jsonIssue,
  items,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ModelMappingsCardProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.mappings.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.mappings.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.mappings.hint")}
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
            <Label className="text-muted-foreground text-xs">
              {t("settingsPage.common.jsonMode")}
            </Label>
          </div>
        </div>

        {mode === "json" ? (
          <div className="space-y-2">
            <Textarea
              value={json}
              onChange={(e) => onJsonChange(e.target.value)}
              className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
              placeholder={t("settingsPage.mappings.jsonPlaceholder")}
            />
            {jsonIssue ? (
              <InlineAlert
                variant="warning"
                title={t("settingsPage.common.invalidJsonTitle")}
                description={jsonIssue}
              />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                {t("settingsPage.mappings.emptyState")}
              </div>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className="grid gap-2 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                >
                  <label className="grid gap-1">
                    <span className="text-muted-foreground text-xs">
                      {t("settingsPage.mappings.sourceLabel")}
                    </span>
                    <Input
                      value={item.source}
                      placeholder={t("settingsPage.mappings.sourcePlaceholder")}
                      onChange={(e) =>
                        onUpdateItem(item.id, { source: e.target.value })
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-muted-foreground text-xs">
                      {t("settingsPage.mappings.targetLabel")}
                    </span>
                    <Input
                      value={item.target}
                      placeholder={t("settingsPage.mappings.targetPlaceholder")}
                      onChange={(e) =>
                        onUpdateItem(item.id, { target: e.target.value })
                      }
                    />
                  </label>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRemoveItem(item.id)}
                    >
                      {t("settingsPage.common.remove")}
                    </Button>
                  </div>
                </div>
              ))
            )}

            <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
              {t("settingsPage.mappings.addButton")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type ResponsesApiSettingsCardProps = {
  useResponsesApiWebSocket: boolean
  useResponsesApiWebSearch: boolean
  messageApiWebSearchModelValue: string
  claudeAutoModelValue: string
  contextManagementMessages: boolean
  contextManagementResponses: boolean
  responsesApiContextManagementModelsValue: string
  compactThresholdsMode: JsonMode
  compactThresholdsJson: string
  compactThresholdsJsonIssue: string | null
  compactThresholdsItems: Array<CompactThresholdItem>
  models: Array<string>
  providerModelSuggestions?: Array<string>
  onToggleUseResponsesApiWebSocket: (value: boolean) => void
  onToggleUseResponsesApiWebSearch: (value: boolean) => void
  onMessageApiWebSearchModelChange: (value: string) => void
  onClaudeAutoModelChange: (value: string) => void
  onToggleContextManagementMessages: (value: boolean) => void
  onToggleContextManagementResponses: (value: boolean) => void
  onResponsesApiContextManagementModelsChange: (value: string) => void
  onCompactThresholdsToggleMode: (next: boolean) => void
  onCompactThresholdsJsonChange: (value: string) => void
  onCompactThresholdsAddItem: () => void
  onCompactThresholdsRemoveItem: (id: string) => void
  onCompactThresholdsUpdateItem: (
    id: string,
    patch: Partial<CompactThresholdItem>,
  ) => void
}

export function ResponsesApiSettingsCard({
  useResponsesApiWebSocket,
  useResponsesApiWebSearch,
  messageApiWebSearchModelValue,
  claudeAutoModelValue,
  contextManagementMessages,
  contextManagementResponses,
  responsesApiContextManagementModelsValue,
  compactThresholdsMode,
  compactThresholdsJson,
  compactThresholdsJsonIssue,
  compactThresholdsItems,
  models,
  providerModelSuggestions = [],
  onToggleUseResponsesApiWebSocket,
  onToggleUseResponsesApiWebSearch,
  onMessageApiWebSearchModelChange,
  onClaudeAutoModelChange,
  onToggleContextManagementMessages,
  onToggleContextManagementResponses,
  onResponsesApiContextManagementModelsChange,
  onCompactThresholdsToggleMode,
  onCompactThresholdsJsonChange,
  onCompactThresholdsAddItem,
  onCompactThresholdsRemoveItem,
  onCompactThresholdsUpdateItem,
}: ResponsesApiSettingsCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const copilotSuggestions = models.slice(0, 6)
  const currentValue = messageApiWebSearchModelValue.trim()
  const allSuggestions = new Set(
    [...copilotSuggestions, ...providerModelSuggestions].map((value) => value.toLowerCase()),
  )
  const showCustomValue = currentValue.length > 0 && !allSuggestions.has(currentValue.toLowerCase())

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.responsesApi.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.responsesApi.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("settingsPage.responsesApi.transportGroupTitle")}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.responsesApi.useResponsesApiWebSocketLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.useResponsesApiWebSocketHint")}
            </div>
          </div>
          <Switch
            checked={useResponsesApiWebSocket}
            onCheckedChange={onToggleUseResponsesApiWebSocket}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.responsesApi.useResponsesApiWebSearchLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.useResponsesApiWebSearchHint")}
            </div>
          </div>
          <Switch
            checked={useResponsesApiWebSearch}
            onCheckedChange={onToggleUseResponsesApiWebSearch}
          />
        </div>

        <div className="grid gap-2 rounded-lg border p-3">
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.messageApiWebSearchModelLabel")}
            </Label>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.messageApiWebSearchModelHint")}
            </div>
          </div>
          <Input
            autoComplete="off"
            placeholder={t(
              "settingsPage.responsesApi.messageApiWebSearchModelPlaceholder",
            )}
            value={messageApiWebSearchModelValue}
            onChange={(e) => onMessageApiWebSearchModelChange(e.target.value)}
            className="font-mono text-xs"
          />
          <div className="space-y-2">
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.messageApiWebSearchSuggestionsHint")}
            </div>
            {copilotSuggestions.length > 0 ? (
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs font-medium">
                  {t("settingsPage.responsesApi.copilotModelSuggestionsLabel")}
                </div>
                <div className="flex flex-wrap gap-2">
                  {copilotSuggestions.map((model) => (
                    <Button
                      key={model}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 font-mono text-xs"
                      onClick={() => onMessageApiWebSearchModelChange(model)}
                    >
                      {model}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {providerModelSuggestions.length > 0 ? (
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs font-medium">
                  {t("settingsPage.responsesApi.providerModelSuggestionsLabel")}
                </div>
                <div className="flex flex-wrap gap-2">
                  {providerModelSuggestions.map((model) => (
                    <Button
                      key={model}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 font-mono text-xs"
                      onClick={() => onMessageApiWebSearchModelChange(model)}
                    >
                      {model}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {showCustomValue ? (
              <div className="text-muted-foreground text-xs">
                {t("settingsPage.responsesApi.messageApiWebSearchCustomValue", {
                  value: currentValue,
                })}
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid gap-2 rounded-lg border p-3">
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.claudeAutoModelLabel")}
            </Label>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.claudeAutoModelHint")}
            </div>
          </div>
          <Input
            autoComplete="off"
            placeholder={t(
              "settingsPage.responsesApi.claudeAutoModelPlaceholder",
            )}
            value={claudeAutoModelValue}
            onChange={(e) => onClaudeAutoModelChange(e.target.value)}
            className="font-mono text-xs"
          />
        </div>

        <hr className="border-t" />
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("settingsPage.responsesApi.contextManagementGroupTitle")}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t(
                "settingsPage.responsesApi.contextManagementMessagesLabel",
              )}
            </div>
            <div className="text-muted-foreground text-xs">
              {t(
                "settingsPage.responsesApi.contextManagementMessagesHint",
              )}
            </div>
          </div>
          <Switch
            checked={contextManagementMessages}
            onCheckedChange={onToggleContextManagementMessages}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t(
                "settingsPage.responsesApi.contextManagementResponsesLabel",
              )}
            </div>
            <div className="text-muted-foreground text-xs">
              {t(
                "settingsPage.responsesApi.contextManagementResponsesHint",
              )}
            </div>
          </div>
          <Switch
            checked={contextManagementResponses}
            onCheckedChange={onToggleContextManagementResponses}
          />
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.compactThresholds.title")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.compactThresholds.description")}
            </div>
          </div>
          <CompactThresholdsCard
            embedded
            contextManagementEnabled={
              contextManagementMessages || contextManagementResponses
            }
            mode={compactThresholdsMode}
            json={compactThresholdsJson}
            jsonIssue={compactThresholdsJsonIssue}
            items={compactThresholdsItems}
            models={models}
            onToggleMode={onCompactThresholdsToggleMode}
            onJsonChange={onCompactThresholdsJsonChange}
            onAddItem={onCompactThresholdsAddItem}
            onRemoveItem={onCompactThresholdsRemoveItem}
            onUpdateItem={onCompactThresholdsUpdateItem}
          />
        </div>

        <hr className="border-t" />
        <div className="grid gap-2 rounded-lg border border-dashed p-3">
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">
              {t(
                "settingsPage.responsesApi.responsesApiContextManagementModelsLabel",
              )}
            </Label>
            <div className="text-muted-foreground text-xs">
              {t(
                "settingsPage.responsesApi.responsesApiContextManagementModelsDeprecatedHint",
              )}
            </div>
            {!contextManagementMessages && !contextManagementResponses ? (
              <div className="text-muted-foreground text-xs">
                {t("settingsPage.responsesApi.contextManagementInactiveHint")}
              </div>
            ) : null}
          </div>
          <Textarea
            autoComplete="off"
            placeholder={t(
              "settingsPage.responsesApi.responsesApiContextManagementModelsPlaceholder",
            )}
            value={responsesApiContextManagementModelsValue}
            onChange={(e) =>
              onResponsesApiContextManagementModelsChange(e.target.value)
            }
            className="min-h-[96px] font-mono text-xs"
          />
        </div>
      </CardContent>
    </Card>
  )
}

type DeveloperModeCardProps = {
  devMode: DevModeState
  saving: boolean
  onToggleEnabled: (value: boolean) => void
  onCaptureChange: (field: "capture4xx" | "capture5xx" | "captureOther", value: boolean) => void
}

function DeveloperModeCard({
  devMode,
  saving,
  onToggleEnabled,
  onCaptureChange,
}: DeveloperModeCardProps): React.JSX.Element {
  const { t } = useTranslation()

  const anyCaptureEnabled = devMode.capture4xx || devMode.capture5xx || devMode.captureOther

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.devMode.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.devMode.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.devMode.enable")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.devMode.enableHint")}
            </div>
          </div>
          <Switch
            checked={devMode.enabled}
            disabled={saving}
            onCheckedChange={onToggleEnabled}
          />
        </div>

        {devMode.enabled ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">
              {t("settingsPage.devMode.captureLabel")}
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm">
                <Switch
                  checked={devMode.capture4xx}
                  disabled={saving}
                  onCheckedChange={(v) => onCaptureChange("capture4xx", v)}
                  className="scale-75"
                />
                {t("settingsPage.devMode.capture4xx")}
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <Switch
                  checked={devMode.capture5xx}
                  disabled={saving}
                  onCheckedChange={(v) => onCaptureChange("capture5xx", v)}
                  className="scale-75"
                />
                {t("settingsPage.devMode.capture5xx")}
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <Switch
                  checked={devMode.captureOther}
                  disabled={saving}
                  onCheckedChange={(v) => onCaptureChange("captureOther", v)}
                  className="scale-75"
                />
                {t("settingsPage.devMode.captureOther")}
              </label>
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.devMode.captureHint")}
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.devMode.captureDisabled")}
          </div>
        )}

        {devMode.enabled && anyCaptureEnabled ? (
          <InlineAlert
            variant="warning"
            title={t("settingsPage.devMode.captureLabel")}
            description={t("settingsPage.devMode.captureHint")}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

type AdvancedSettingsCardProps = {
  accountAffinityEnabled: boolean
  modelRefreshIntervalInput: string
  modelRefreshIntervalIssue: string | null
  sessionAffinityRetentionInput: string
  sessionAffinityRetentionIssue: string | null
  allowOriginalModelNamesForAliases: boolean
  forceAgent: boolean
  compactUseSmallModel: boolean
  messageStartInputTokensFallback: boolean
  useMessagesApi: boolean
  onToggleAccountAffinity: (value: boolean) => void
  onModelRefreshIntervalChange: (value: string) => void
  onSessionAffinityRetentionChange: (value: string) => void
  onToggleAllowOriginalModelNamesForAliases: (value: boolean) => void
  onToggleForceAgent: (value: boolean) => void
  onToggleCompactUseSmallModel: (value: boolean) => void
  onToggleMessageStartInputTokensFallback: (value: boolean) => void
  onToggleUseMessagesApi: (value: boolean) => void
}

export function AdvancedSettingsCard({
  accountAffinityEnabled,
  modelRefreshIntervalInput,
  modelRefreshIntervalIssue,
  sessionAffinityRetentionInput,
  sessionAffinityRetentionIssue,
  allowOriginalModelNamesForAliases,
  forceAgent,
  compactUseSmallModel,
  messageStartInputTokensFallback,
  useMessagesApi,
  onToggleAccountAffinity,
  onModelRefreshIntervalChange,
  onSessionAffinityRetentionChange,
  onToggleAllowOriginalModelNamesForAliases,
  onToggleForceAgent,
  onToggleCompactUseSmallModel,
  onToggleMessageStartInputTokensFallback,
  onToggleUseMessagesApi,
}: AdvancedSettingsCardProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.advanced.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.advanced.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {/* — Routing — */}
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("settingsPage.advanced.routingGroupTitle")}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.accountAffinity.label")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.accountAffinity.hint")}
            </div>
          </div>
          <Switch
            checked={accountAffinityEnabled}
            onCheckedChange={onToggleAccountAffinity}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.advanced.allowOriginalModelNamesLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.allowOriginalModelNamesHint")}
            </div>
          </div>
          <Switch
            checked={allowOriginalModelNamesForAliases}
            onCheckedChange={onToggleAllowOriginalModelNamesForAliases}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.advanced.forceAgentLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.forceAgentHint")}
            </div>
          </div>
          <Switch checked={forceAgent} onCheckedChange={onToggleForceAgent} />
        </div>

        {/* — API Endpoints — */}
        <hr className="border-t mt-1" />
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("settingsPage.advanced.apiGroupTitle")}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.advanced.useMessagesApiLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.useMessagesApiHint")}
            </div>
          </div>
          <Switch checked={useMessagesApi} onCheckedChange={onToggleUseMessagesApi} />
        </div>

        {/* — Model & Tokens — */}
        <hr className="border-t mt-1" />
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("settingsPage.advanced.modelGroupTitle")}
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.modelRefreshIntervalLabel")}
          </Label>
          <Input
            type="number"
            min="0"
            step="0.5"
            value={modelRefreshIntervalInput}
            onChange={(e) => onModelRefreshIntervalChange(e.target.value)}
          />
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.modelRefreshIntervalHint")}
          </div>
          {modelRefreshIntervalIssue ? (
            <div className="text-destructive text-xs">
              {modelRefreshIntervalIssue}
            </div>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.sessionAffinityRetentionLabel")}
          </Label>
          <Input
            type="number"
            min="0"
            step="1"
            value={sessionAffinityRetentionInput}
            onChange={(e) => onSessionAffinityRetentionChange(e.target.value)}
          />
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.sessionAffinityRetentionHint")}
          </div>
          {sessionAffinityRetentionIssue ? (
            <div className="text-destructive text-xs">
              {sessionAffinityRetentionIssue}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">{t("settingsPage.advanced.compactUseSmallModelLabel")}</div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.compactUseSmallModelHint")}
            </div>
          </div>
          <Switch
            checked={compactUseSmallModel}
            onCheckedChange={onToggleCompactUseSmallModel}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.advanced.messageStartInputTokensFallbackLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.messageStartInputTokensFallbackHint")}
            </div>
          </div>
          <Switch
            checked={messageStartInputTokensFallback}
            onCheckedChange={onToggleMessageStartInputTokensFallback}
          />
        </div>
      </CardContent>
    </Card>
  )
}

type ProviderModelRowProps = {
  providerId: string
  item: ProviderModelItem
  onRemoveModel: (providerId: string, modelItemId: string) => void
  onUpdateModel: (
    providerId: string,
    modelItemId: string,
    patch: Partial<ProviderModelItem>,
  ) => void
}

function ProviderModelRow({
  providerId,
  item,
  onRemoveModel,
  onUpdateModel,
}: ProviderModelRowProps): React.JSX.Element {
  const { t } = useTranslation()

  const onToggleToolContentSupportType = (
    type: ToolContentSupportType,
    checked: boolean,
  ) => {
    const next =
      checked ?
        [...new Set(item.toolContentSupportType.concat(type))]
      : item.toolContentSupportType.filter((current) => current !== type)
    onUpdateModel(providerId, item.id, { toolContentSupportType: next })
  }

  return (
    <div className="grid gap-3 rounded-md border border-dashed p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[180px]"
          placeholder={t("settingsPage.advanced.providersModelIdPlaceholder")}
          value={item.model}
          onChange={(e) => onUpdateModel(providerId, item.id, { model: e.target.value })}
        />
        <Input
          className="w-28"
          type="number"
          step="0.1"
          min="0"
          placeholder="temperature"
          value={item.temperature}
          onChange={(e) =>
            onUpdateModel(providerId, item.id, { temperature: e.target.value })
          }
        />
        <Input
          className="w-28"
          type="number"
          step="0.01"
          min="0"
          placeholder="topP"
          value={item.topP}
          onChange={(e) => onUpdateModel(providerId, item.id, { topP: e.target.value })}
        />
        <Input
          className="w-28"
          type="number"
          step="1"
          min="0"
          placeholder="topK"
          value={item.topK}
          onChange={(e) => onUpdateModel(providerId, item.id, { topK: e.target.value })}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRemoveModel(providerId, item.id)}
        >
          {t("settingsPage.common.remove")}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid gap-2 rounded-md bg-muted/40 px-3 py-2">
          <Label className="text-sm font-medium">
            {t("settingsPage.advanced.providersModelTypeLabel")}
          </Label>
          <Select
            value={item.modelTypeConfigured ? item.modelType : "inherit"}
            onValueChange={(value) =>
              onUpdateModel(providerId, item.id, {
                modelType: value,
                modelTypeConfigured: value !== "inherit",
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">
                {t("settingsPage.advanced.providersModelTypeInherit")}
              </SelectItem>
              <SelectItem value="anthropic">
                {t("settingsPage.advanced.providersTypeAnthropic")}
              </SelectItem>
              <SelectItem value="openai-compatible">
                {t("settingsPage.advanced.providersTypeOpenAICompatible")}
              </SelectItem>
              <SelectItem value="openai-responses">
                {t("settingsPage.advanced.providersTypeOpenAIResponses")}
              </SelectItem>
            </SelectContent>
          </Select>
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersModelTypeHint")}
          </div>
        </div>

        <div className="grid gap-2 rounded-md bg-muted/40 px-3 py-2">
          <Label className="text-sm font-medium">
            {t("settingsPage.advanced.providersContextCacheLabel")}
          </Label>
          <Select
            value={
              item.contextCacheConfigured ?
                item.contextCache ? "true" : "false"
              : "inherit"
            }
            onValueChange={(value) =>
              onUpdateModel(providerId, item.id, {
                contextCache: value === "true",
                contextCacheConfigured: value !== "inherit",
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">
                {t("settingsPage.advanced.providersBooleanInherit")}
              </SelectItem>
              <SelectItem value="true">
                {t("settingsPage.advanced.providersBooleanEnabled")}
              </SelectItem>
              <SelectItem value="false">
                {t("settingsPage.advanced.providersBooleanDisabled")}
              </SelectItem>
            </SelectContent>
          </Select>
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersContextCacheHint")}
          </div>
        </div>

        <div className="grid gap-2 rounded-md bg-muted/40 px-3 py-2">
          <Label className="text-sm font-medium">
            {t("settingsPage.advanced.providersSupportPdfLabel")}
          </Label>
          <Select
            value={
              item.supportPdfConfigured ?
                item.supportPdf ? "true" : "false"
              : "inherit"
            }
            onValueChange={(value) =>
              onUpdateModel(providerId, item.id, {
                supportPdf: value === "true",
                supportPdfConfigured: value !== "inherit",
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">
                {t("settingsPage.advanced.providersBooleanInherit")}
              </SelectItem>
              <SelectItem value="true">
                {t("settingsPage.advanced.providersBooleanEnabled")}
              </SelectItem>
              <SelectItem value="false">
                {t("settingsPage.advanced.providersBooleanDisabled")}
              </SelectItem>
            </SelectContent>
          </Select>
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersSupportPdfHint")}
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        <Label className="text-muted-foreground text-xs">
          {t("settingsPage.advanced.providersToolContentSupportTypeLabel")}
        </Label>
        <div className="flex flex-wrap gap-2">
          {TOOL_CONTENT_SUPPORT_TYPES.map((type) => (
            <label
              key={type}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            >
              <input
                type="checkbox"
                checked={item.toolContentSupportType.includes(type)}
                onChange={(e) =>
                  onToggleToolContentSupportType(type, e.target.checked)
                }
              />
              {type}
            </label>
          ))}
        </div>
        <div className="text-muted-foreground text-xs">
          {t("settingsPage.advanced.providersToolContentSupportTypeHint")}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersPricingLabel")}
          </Label>
          <Textarea
            className="min-h-28 font-mono text-xs"
            placeholder={t("settingsPage.advanced.providersPricingPlaceholder")}
            value={item.pricingJson}
            onChange={(e) =>
              onUpdateModel(providerId, item.id, { pricingJson: e.target.value })
            }
          />
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersExtraBodyLabel")}
          </Label>
          <Textarea
            className="min-h-28 font-mono text-xs"
            placeholder={t("settingsPage.advanced.providersExtraBodyPlaceholder")}
            value={item.extraBodyJson}
            onChange={(e) =>
              onUpdateModel(providerId, item.id, { extraBodyJson: e.target.value })
            }
          />
        </div>
      </div>
    </div>
  )
}

type ProviderItemCardProps = {
  item: ProviderItem
  onRemoveProvider: (id: string) => void
  onUpdateProvider: (id: string, patch: Partial<ProviderItem>) => void
  onAddModel: (providerId: string) => void
  onRemoveModel: (providerId: string, modelItemId: string) => void
  onUpdateModel: (
    providerId: string,
    modelItemId: string,
    patch: Partial<ProviderModelItem>,
  ) => void
}

function ProviderItemCard({
  item,
  onRemoveProvider,
  onUpdateProvider,
  onAddModel,
  onRemoveModel,
  onUpdateModel,
}: ProviderItemCardProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[200px]"
          placeholder={t("settingsPage.advanced.providersNamePlaceholder")}
          value={item.name}
          onChange={(e) => onUpdateProvider(item.id, { name: e.target.value })}
        />
        <Select
          value={item.type}
          onValueChange={(value) =>
            onUpdateProvider(item.id, { type: value as ProviderType })
          }
        >
          <SelectTrigger className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic">
              {t("settingsPage.advanced.providersTypeAnthropic")}
            </SelectItem>
            <SelectItem value="openai-compatible">
              {t("settingsPage.advanced.providersTypeOpenAICompatible")}
            </SelectItem>
            <SelectItem value="openai-responses">
              {t("settingsPage.advanced.providersTypeOpenAIResponses")}
            </SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch
            checked={item.enabled}
            onCheckedChange={(value) => onUpdateProvider(item.id, { enabled: value })}
          />
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersEnabledLabel")}
          </Label>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRemoveProvider(item.id)}
        >
          {t("settingsPage.common.remove")}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="grid gap-2 md:col-span-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersBaseUrlLabel")}
          </Label>
          <Input
            autoComplete="off"
            placeholder={t("settingsPage.advanced.providersBaseUrlPlaceholder")}
            value={item.baseUrl}
            onChange={(e) => onUpdateProvider(item.id, { baseUrl: e.target.value })}
          />
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersApiKeyLabel")}
          </Label>
          <Input
            type="password"
            autoComplete="off"
            placeholder={t("settingsPage.advanced.providersApiKeyPlaceholder")}
            value={item.apiKey}
            onChange={(e) => onUpdateProvider(item.id, { apiKey: e.target.value })}
          />
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersPricingCurrencyLabel")}
          </Label>
          <Input
            autoComplete="off"
            placeholder={t("settingsPage.advanced.providersPricingCurrencyPlaceholder")}
            value={item.pricingCurrency}
            onChange={(e) =>
              onUpdateProvider(item.id, { pricingCurrency: e.target.value })
            }
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersTypeLabel")}
          </Label>
          <div className="text-muted-foreground rounded-md bg-muted/40 px-3 py-2 text-xs">
            {t("settingsPage.advanced.providersTypeHint")}
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersAuthTypeLabel")}
          </Label>
          <Select
            value={item.authType}
            onValueChange={(value) =>
              onUpdateProvider(item.id, { authType: value as ProviderAuthType })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="x-api-key">
                {t("settingsPage.advanced.providersAuthTypeXApiKey")}
              </SelectItem>
              <SelectItem value="authorization">
                {t("settingsPage.advanced.providersAuthTypeAuthorization")}
              </SelectItem>
              <SelectItem value="oauth2">
                {t("settingsPage.advanced.providersAuthTypeOauth2")}
              </SelectItem>
            </SelectContent>
          </Select>
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersAuthTypeHint")}
          </div>
          {item.authType === "oauth2" ? (
            <div className="text-muted-foreground rounded-md bg-muted/40 px-3 py-2 text-xs">
              {t("settingsPage.advanced.providersOAuth2Hint")}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-sm font-medium">
            {t("settingsPage.advanced.providersAdjustInputTokensLabel")}
          </div>
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersAdjustInputTokensHint")}
          </div>
        </div>
        <Switch
          checked={item.adjustInputTokens}
          onCheckedChange={(value) =>
            onUpdateProvider(item.id, { adjustInputTokens: value })
          }
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">
            {t("settingsPage.advanced.providersModelsLabel")}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onAddModel(item.id)}
          >
            {t("settingsPage.advanced.providersAddModel")}
          </Button>
        </div>

        {item.models.length === 0 ? (
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersModelsEmptyState")}
          </div>
        ) : (
          item.models.map((model) => (
            <ProviderModelRow
              key={model.id}
              providerId={item.id}
              item={model}
              onUpdateModel={onUpdateModel}
              onRemoveModel={onRemoveModel}
            />
          ))
        )}
      </div>
    </div>
  )
}

type ProvidersSettingsCardProps = {
  items: Array<ProviderItem>
  issue: string | null
  onAddProvider: () => void
  onQuickAddProvider: (name: QuickProviderName) => void
  onRemoveProvider: (id: string) => void
  onUpdateProvider: (id: string, patch: Partial<ProviderItem>) => void
  onAddModel: (providerId: string) => void
  onRemoveModel: (providerId: string, modelItemId: string) => void
  onUpdateModel: (
    providerId: string,
    modelItemId: string,
    patch: Partial<ProviderModelItem>,
  ) => void
}

function ProvidersSettingsCard({
  items,
  issue,
  onAddProvider,
  onQuickAddProvider,
  onRemoveProvider,
  onUpdateProvider,
  onAddModel,
  onRemoveModel,
  onUpdateModel,
}: ProvidersSettingsCardProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.advanced.providersTitle")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.advanced.providersDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {issue ? (
          <InlineAlert
            variant="warning"
            title={t("settingsPage.advanced.providersIssueTitle")}
            description={issue}
          />
        ) : null}

        {items.length === 0 ? (
          <div className="text-muted-foreground text-sm">
            {t("settingsPage.advanced.providersEmptyState")}
          </div>
        ) : (
          items.map((item) => (
            <ProviderItemCard
              key={item.id}
              item={item}
              onRemoveProvider={onRemoveProvider}
              onUpdateProvider={onUpdateProvider}
              onAddModel={onAddModel}
              onRemoveModel={onRemoveModel}
              onUpdateModel={onUpdateModel}
            />
          ))
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {t("settingsPage.advanced.providersQuickAddLabel")}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onQuickAddProvider("opencode-go")}
          >
            {t("settingsPage.advanced.providersQuickAddOpenCodeGo")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onQuickAddProvider("deepseek")}
          >
            {t("settingsPage.advanced.providersQuickAddDeepSeek")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onQuickAddProvider("dashscope")}
          >
            {t("settingsPage.advanced.providersQuickAddDashScope")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onQuickAddProvider("openrouter")}
          >
            {t("settingsPage.advanced.providersQuickAddOpenRouter")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onQuickAddProvider("custom")}
          >
            {t("settingsPage.advanced.providersQuickAddCustom")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onAddProvider}>
            {t("settingsPage.advanced.providersAddProvider")}
          </Button>
        </div>
        <div className="text-muted-foreground text-xs">
          {t("settingsPage.advanced.providersQuickAddHint")}
        </div>
      </CardContent>
    </Card>
  )
}

type DraftNonNegativeNumberKey =
  | "modelRefreshIntervalHours"
  | "sessionAffinityRetentionDays"

function toNumberInputValue(value: number | undefined): string {
  return typeof value === "number" ? String(value) : ""
}

function setDraftNonNegativeNumberValue(
  draft: AdminConfig,
  key: DraftNonNegativeNumberKey,
  value: number | undefined,
): AdminConfig {
  switch (key) {
    case "modelRefreshIntervalHours":
      return {
        ...draft,
        modelRefreshIntervalHours: value,
      }
    case "sessionAffinityRetentionDays":
      return {
        ...draft,
        sessionAffinityRetentionDays: value,
      }
  }
}

function applyNonNegativeNumberInputChange(params: {
  value: string
  key: DraftNonNegativeNumberKey
  issueMessage: string
  setInput: Dispatch<SetStateAction<string>>
  setIssue: Dispatch<SetStateAction<string | null>>
  setDraft: Dispatch<SetStateAction<AdminConfig>>
}): void {
  const { value, key, issueMessage, setInput, setIssue, setDraft } = params

  setInput(value)

  const trimmed = value.trim()
  if (!trimmed) {
    setIssue(null)
    setDraft((prev) => setDraftNonNegativeNumberValue(prev, key, undefined))
    return
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) {
    setIssue(issueMessage)
    return
  }

  setIssue(null)
  setDraft((prev) => setDraftNonNegativeNumberValue(prev, key, parsed))
}

type SettingsPageViewProps = {
  loading: boolean
  saving: boolean
  error: string | null
  configPath: string | null
  canSave: boolean
  isDirty: boolean
  onReload: () => void
  onSave: () => void
  devMode: DevModeState
  onDevModeEnabledToggle: (value: boolean) => void
  onDevModeCaptureChange: (field: "capture4xx" | "capture5xx" | "captureOther", value: boolean) => void
  hasModels: boolean
  smallModelLabel: string
  smallModelValue: string
  smallModelInputValue: string
  models: Array<string>
  authApiKeysValue: string
  anthropicApiKeyValue: string
  legacyAuthNote: string
  anthropicApiKeyEnvNote: string
  onSmallModelSelect: (value: string) => void
  onSmallModelInput: (value: string) => void
  onAuthApiKeysChange: (value: string) => void
  onAnthropicApiKeyChange: (value: string) => void
  accountAffinityEnabled: boolean
  onAccountAffinityToggle: (value: boolean) => void
  modelRefreshIntervalInput: string
  modelRefreshIntervalIssue: string | null
  onModelRefreshIntervalChange: (value: string) => void
  sessionAffinityRetentionInput: string
  sessionAffinityRetentionIssue: string | null
  onSessionAffinityRetentionChange: (value: string) => void
  reasoningMode: JsonMode
  reasoningJson: string
  reasoningJsonIssue: string | null
  reasoningItems: Array<ReasoningItem>
  reasoningSupportByModel: Record<string, ReasoningSupportInfo>
  reasoningSupportLoaded: boolean
  onReasoningToggleMode: (next: boolean) => void
  onReasoningJsonChange: (value: string) => void
  onReasoningAddItem: () => void
  onReasoningRemoveItem: (id: string) => void
  onReasoningUpdateItem: (id: string, value: Partial<ReasoningItem>) => void
  compactThresholdsMode: JsonMode
  compactThresholdsJson: string
  compactThresholdsJsonIssue: string | null
  compactThresholdsItems: Array<CompactThresholdItem>
  providerModelSuggestions: Array<string>
  onCompactThresholdsToggleMode: (next: boolean) => void
  onCompactThresholdsJsonChange: (value: string) => void
  onCompactThresholdsAddItem: () => void
  onCompactThresholdsRemoveItem: (id: string) => void
  onCompactThresholdsUpdateItem: (
    id: string,
    value: Partial<CompactThresholdItem>,
  ) => void
  extraMode: JsonMode
  extraJson: string
  extraJsonIssue: string | null
  extraItems: Array<ExtraPromptItem>
  onExtraToggleMode: (next: boolean) => void
  onExtraJsonChange: (value: string) => void
  onExtraAddItem: () => void
  onExtraRemoveItem: (id: string) => void
  onExtraUpdateItem: (id: string, value: Partial<ExtraPromptItem>) => void
  aliasMode: JsonMode
  aliasJson: string
  aliasJsonIssue: string | null
  aliasItems: Array<ModelAliasItem>
  onAliasToggleMode: (next: boolean) => void
  onAliasJsonChange: (value: string) => void
  onAliasAddItem: () => void
  onAliasRemoveItem: (id: string) => void
  onAliasUpdateItem: (id: string, value: Partial<ModelAliasItem>) => void
  mappingMode: JsonMode
  mappingJson: string
  mappingJsonIssue: string | null
  mappingItems: Array<ModelMappingItem>
  onMappingToggleMode: (next: boolean) => void
  onMappingJsonChange: (value: string) => void
  onMappingAddItem: () => void
  onMappingRemoveItem: (id: string) => void
  onMappingUpdateItem: (id: string, value: Partial<ModelMappingItem>) => void
  allowOriginalModelNamesForAliases: boolean
  forceAgent: boolean
  compactUseSmallModel: boolean
  messageStartInputTokensFallback: boolean
  useMessagesApi: boolean
  useResponsesApiWebSocket: boolean
  useResponsesApiWebSearch: boolean
  messageApiWebSearchModelValue: string
  claudeAutoModelValue: string
  contextManagementMessages: boolean
  contextManagementResponses: boolean
  responsesApiContextManagementModelsValue: string
  onUseMessagesApiToggle: (value: boolean) => void
  onUseResponsesApiWebSocketToggle: (value: boolean) => void
  onUseResponsesApiWebSearchToggle: (value: boolean) => void
  onMessageApiWebSearchModelChange: (value: string) => void
  onClaudeAutoModelChange: (value: string) => void
  onContextManagementMessagesToggle: (value: boolean) => void
  onContextManagementResponsesToggle: (value: boolean) => void
  onResponsesApiContextManagementModelsChange: (value: string) => void
  providersItems: Array<ProviderItem>
  providersIssue: string | null
  onProvidersAddProvider: () => void
  onProvidersQuickAddProvider: (name: QuickProviderName) => void
  onProvidersRemoveProvider: (id: string) => void
  onProvidersUpdateProvider: (id: string, patch: Partial<ProviderItem>) => void
  onProvidersAddModel: (providerId: string) => void
  onProvidersRemoveModel: (providerId: string, modelItemId: string) => void
  onProvidersUpdateModel: (
    providerId: string,
    modelItemId: string,
    patch: Partial<ProviderModelItem>,
  ) => void
  onAllowOriginalModelNamesForAliasesToggle: (value: boolean) => void
  onForceAgentToggle: (value: boolean) => void
  onCompactUseSmallModelToggle: (value: boolean) => void
  onMessageStartInputTokensFallbackToggle: (value: boolean) => void
}

function useSettingsPageState(): SettingsPageViewProps {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configPath, setConfigPath] = useState<string | null>(null)

  const [models, setModels] = useState<Array<string>>([])
  const [reasoningSupportByModel, setReasoningSupportByModel] = useState<
    Record<string, ReasoningSupportInfo>
  >({})
  const [reasoningSupportLoaded, setReasoningSupportLoaded] = useState(false)
  const [devMode, setDevModeState] = useState<DevModeState>({
    enabled: false,
    capture4xx: false,
    capture5xx: false,
    captureOther: false,
  })
  const [draft, setDraft] = useState<AdminConfig>({})
  const [initialDraftJson, setInitialDraftJson] = useState<string>("{}")
  const [modelRefreshIntervalInput, setModelRefreshIntervalInput] =
    useState<string>("")
  const [modelRefreshIntervalIssue, setModelRefreshIntervalIssue] = useState<
    string | null
  >(null)
  const [sessionAffinityRetentionInput, setSessionAffinityRetentionInput] =
    useState<string>("")
  const [sessionAffinityRetentionIssue, setSessionAffinityRetentionIssue] =
    useState<string | null>(null)
  const [
    responsesApiContextManagementModelsValue,
    setResponsesApiContextManagementModelsValue,
  ] = useState<string>("")

  const extraEditor = useExtraPromptEditor((record) =>
    setDraft((prev) => ({ ...prev, extraPrompts: record })),
  )
  const reasoningEditor = useReasoningEditor((record) =>
    setDraft((prev) => ({ ...prev, modelReasoningEfforts: record })),
  )
  const compactThresholdsEditor = useCompactThresholdEditor((record) =>
    setDraft((prev) => ({
      ...prev,
      modelResponsesApiCompactThresholds: record,
    })),
  )

  const aliasEditor = useModelAliasEditor((record) =>
    setDraft((prev) => ({ ...prev, modelAliases: record })),
  )

  const mappingEditor = useModelMappingEditor((record) =>
    setDraft((prev) => ({ ...prev, modelMappings: record })),
  )

  const providersEditor = useProvidersEditor((record) =>
    setDraft((prev) => ({ ...prev, providers: record })),
  )

  const {
    mode: extraMode,
    items: extraItems,
    json: extraJson,
    jsonIssue: extraJsonIssue,
    onToggleMode: onExtraToggleMode,
    onJsonChange: onExtraJsonChange,
    onAddItem: onExtraAddItem,
    onRemoveItem: onExtraRemoveItem,
    onUpdateItem: onExtraUpdateItem,
    setFromRecord: setExtraFromRecord,
  } = extraEditor

  const {
    mode: reasoningMode,
    items: reasoningItems,
    json: reasoningJson,
    jsonIssue: reasoningJsonIssue,
    onToggleMode: onReasoningToggleMode,
    onJsonChange: onReasoningJsonChange,
    onAddItem: onReasoningAddItem,
    onRemoveItem: onReasoningRemoveItem,
    onUpdateItem: onReasoningUpdateItem,
    setFromRecord: setReasoningFromRecord,
  } = reasoningEditor

  const {
    mode: compactThresholdsMode,
    items: compactThresholdsItems,
    json: compactThresholdsJson,
    jsonIssue: compactThresholdsJsonIssue,
    onToggleMode: onCompactThresholdsToggleMode,
    onJsonChange: onCompactThresholdsJsonChange,
    onAddItem: onCompactThresholdsAddItem,
    onRemoveItem: onCompactThresholdsRemoveItem,
    onUpdateItem: onCompactThresholdsUpdateItem,
    setFromRecord: setCompactThresholdsFromRecord,
  } = compactThresholdsEditor

  const {
    mode: aliasMode,
    items: aliasItems,
    json: aliasJson,
    jsonIssue: aliasJsonIssue,
    onToggleMode: onAliasToggleMode,
    onJsonChange: onAliasJsonChange,
    onAddItem: onAliasAddItem,
    onRemoveItem: onAliasRemoveItem,
    onUpdateItem: onAliasUpdateItem,
    setFromRecord: setAliasFromRecord,
  } = aliasEditor

  const {
    mode: mappingMode,
    items: mappingItems,
    json: mappingJson,
    jsonIssue: mappingJsonIssue,
    onToggleMode: onMappingToggleMode,
    onJsonChange: onMappingJsonChange,
    onAddItem: onMappingAddItem,
    onRemoveItem: onMappingRemoveItem,
    onUpdateItem: onMappingUpdateItem,
    setFromRecord: setMappingFromRecord,
  } = mappingEditor

  const {
    items: providersItems,
    issue: providersIssue,
    onAddProvider: onProvidersAddProvider,
    onQuickAddProvider: onProvidersQuickAddProvider,
    onRemoveProvider: onProvidersRemoveProvider,
    onUpdateProvider: onProvidersUpdateProvider,
    onAddModel: onProvidersAddModel,
    onRemoveModel: onProvidersRemoveModel,
    onUpdateModel: onProvidersUpdateModel,
    setFromRecord: setProvidersFromRecord,
  } = providersEditor

  const applyConfigResponse = useCallback(
    (config: AdminConfigResponse) => {
      const { _configPath, ...configData } = config
      const aliasItems = aliasItemsFromRecord(configData.modelAliases)
      const normalizedAliases = aliasRecordFromItems(aliasItems)
      const mappingItems = modelMappingItemsFromRecord(configData.modelMappings)
      const normalizedMappings = modelMappingRecordFromItems(mappingItems)
      const normalizedAuthApiKeys = getAuthApiKeysFromConfig(configData)
      const contextManagement = getContextManagementFromConfig(configData)
      const configWithoutDeprecatedContextManagement = { ...configData }
      delete configWithoutDeprecatedContextManagement.useResponsesApiContextManagement

      setConfigPath(_configPath ?? null)
      const normalizedDraft = {
        ...configWithoutDeprecatedContextManagement,
        auth: { apiKeys: normalizedAuthApiKeys },
        contextManagement,
        modelAliases: normalizedAliases,
        modelMappings: normalizedMappings,
      }
      setDraft(normalizedDraft)
      setInitialDraftJson(toComparableDraftJson(normalizedDraft))
      setExtraFromRecord(configData.extraPrompts)
      setReasoningFromRecord(configData.modelReasoningEfforts)
      setCompactThresholdsFromRecord(
        configData.modelResponsesApiCompactThresholds,
      )
      setAliasFromRecord(normalizedAliases)
      setMappingFromRecord(normalizedMappings)
      setProvidersFromRecord(configData.providers)
      setModelRefreshIntervalInput(
        toNumberInputValue(configData.modelRefreshIntervalHours),
      )
      setModelRefreshIntervalIssue(null)
      setSessionAffinityRetentionInput(
        toNumberInputValue(configData.sessionAffinityRetentionDays),
      )
      setSessionAffinityRetentionIssue(null)
      setResponsesApiContextManagementModelsValue(
        configData.responsesApiContextManagementModels?.join("\n") ?? "",
      )
    },
    [
      setExtraFromRecord,
      setReasoningFromRecord,
      setCompactThresholdsFromRecord,
      setAliasFromRecord,
      setMappingFromRecord,
      setProvidersFromRecord,
      setModelRefreshIntervalInput,
      setModelRefreshIntervalIssue,
      setSessionAffinityRetentionInput,
      setSessionAffinityRetentionIssue,
      setResponsesApiContextManagementModelsValue,
    ],
  )

  const loadReasoningSupport = useCallback(async () => {
    setReasoningSupportLoaded(false)
    setReasoningSupportByModel({})

    try {
      const modelDetails = await getAdminModelDetails()
      setReasoningSupportByModel(
        deriveReasoningSupportByModel(modelDetails.items ?? []),
      )
      setReasoningSupportLoaded(true)
    } catch (err) {
      setReasoningSupportByModel({})
      setReasoningSupportLoaded(false)
      toast.error(i18n.t("settingsPage.toast.loadReasoningSupportFailed"), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setReasoningSupportLoaded(false)

    try {
      const [configRes, modelsRes, devModeRes] = await Promise.allSettled([
        getAdminConfig(),
        getAdminModels(),
        getDevMode(),
      ])

      if (configRes.status === "fulfilled") {
        applyConfigResponse(configRes.value)
      } else {
        throw configRes.reason
      }

      if (modelsRes.status === "fulfilled") {
        setModels(modelsRes.value.items ?? [])
      } else {
        setModels([])
        toast.error(i18n.t("settingsPage.toast.loadModelsFailed"), {
          description:
            modelsRes.reason instanceof Error ? modelsRes.reason.message : String(modelsRes.reason),
        })
      }

      if (devModeRes.status === "fulfilled") {
        setDevModeState(devModeRes.value)
      } else {
        setDevModeState({ enabled: false, capture4xx: false, capture5xx: false, captureOther: false })
        toast.error(i18n.t("settingsPage.toast.loadDevModeFailed"), {
          description:
            devModeRes.reason instanceof Error
              ? devModeRes.reason.message
              : String(devModeRes.reason),
        })
      }

      void loadReasoningSupport()
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error(i18n.t("settingsPage.toast.loadConfigFailed"), { description: msg })
    } finally {
      setLoading(false)
    }
  }, [applyConfigResponse, loadReasoningSupport])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)

    try {
      const updated = await updateAdminConfig(draft)
      applyConfigResponse(updated)
      toast.success(i18n.t("settingsPage.toast.configSaved"))
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error(i18n.t("settingsPage.toast.saveConfigFailed"), { description: msg })
    } finally {
      setSaving(false)
    }
  }, [applyConfigResponse, draft])

  const onReload = useCallback(() => {
    void load()
  }, [load])

  const onSave = useCallback(() => {
    void save()
  }, [save])

  const handleSmallModelSelect = useCallback(
    (value: string) => {
      setDraft((prev) => ({
        ...prev,
        smallModel: value === "__default__" ? "" : value,
      }))
    },
    [setDraft],
  )

  const handleSmallModelInput = useCallback(
    (value: string) => {
      setDraft((prev) => ({ ...prev, smallModel: value }))
    },
    [setDraft],
  )

  const handleAuthApiKeysChange = useCallback(
    (value: string) => {
      const apiKeys = parseAuthApiKeysInput(value)
      setDraft((prev) => ({
        ...prev,
        auth: {
          apiKeys,
        },
        apiKey: undefined,
      }))
    },
    [setDraft],
  )

  const handleAnthropicApiKeyChange = useCallback(
    (value: string) => {
      setDraft((prev) => ({ ...prev, anthropicApiKey: value }))
    },
    [setDraft],
  )

  const handleAccountAffinityToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, accountAffinity: value }))
    },
    [setDraft],
  )

  const handleModelRefreshIntervalChange = useCallback(
    (value: string) => {
      applyNonNegativeNumberInputChange({
        value,
        key: "modelRefreshIntervalHours",
        issueMessage: t("settingsPage.advanced.modelRefreshIntervalError"),
        setInput: setModelRefreshIntervalInput,
        setIssue: setModelRefreshIntervalIssue,
        setDraft,
      })
    },
    [setDraft, setModelRefreshIntervalInput, setModelRefreshIntervalIssue, t],
  )

  const handleSessionAffinityRetentionChange = useCallback(
    (value: string) => {
      applyNonNegativeNumberInputChange({
        value,
        key: "sessionAffinityRetentionDays",
        issueMessage: t("settingsPage.advanced.sessionAffinityRetentionError"),
        setInput: setSessionAffinityRetentionInput,
        setIssue: setSessionAffinityRetentionIssue,
        setDraft,
      })
    },
    [
      setDraft,
      setSessionAffinityRetentionInput,
      setSessionAffinityRetentionIssue,
      t,
    ],
  )

  const handleAllowOriginalModelNamesForAliasesToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, allowOriginalModelNamesForAliases: value }))
    },
    [setDraft],
  )

  const handleForceAgentToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, forceAgent: value }))
    },
    [setDraft],
  )

  const handleCompactUseSmallModelToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, compactUseSmallModel: value }))
    },
    [setDraft],
  )

  const handleMessageStartInputTokensFallbackToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, messageStartInputTokensFallback: value }))
    },
    [setDraft],
  )

  const handleUseMessagesApiToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, useMessagesApi: value }))
    },
    [setDraft],
  )

  const handleUseResponsesApiWebSocketToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, useResponsesApiWebSocket: value }))
    },
    [setDraft],
  )

  const handleUseResponsesApiWebSearchToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, useResponsesApiWebSearch: value }))
    },
    [setDraft],
  )

  const handleMessageApiWebSearchModelChange = useCallback(
    (value: string) => {
      setDraft((prev) => ({ ...prev, messageApiWebSearchModel: value }))
    },
    [setDraft],
  )

  const handleClaudeAutoModelChange = useCallback(
    (value: string) => {
      setDraft((prev) => ({ ...prev, claudeAutoModel: value }))
    },
    [setDraft],
  )

  const updateContextManagement = useCallback(
    (patch: Partial<ContextManagementDraft>) => {
      setDraft((prev) => ({
        ...prev,
        contextManagement: {
          ...getContextManagementFromConfig(prev),
          ...patch,
        },
        useResponsesApiContextManagement: undefined,
      }))
    },
    [setDraft],
  )

  const handleContextManagementMessagesToggle = useCallback(
    (value: boolean) => {
      updateContextManagement({ messages: value })
    },
    [updateContextManagement],
  )

  const handleContextManagementResponsesToggle = useCallback(
    (value: boolean) => {
      updateContextManagement({ responses: value })
    },
    [updateContextManagement],
  )

  const handleResponsesApiContextManagementModelsChange = useCallback(
    (value: string) => {
      setResponsesApiContextManagementModelsValue(value)
      const models = parseStringListInput(value)
      setDraft((prev) => ({
        ...prev,
        responsesApiContextManagementModels: models,
      }))
    },
    [setDraft, setResponsesApiContextManagementModelsValue],
  )

  const hasModels = models.length > 0
  const smallModelValue = draft.smallModel ? draft.smallModel : "__default__"
  const canSave =
    !saving
    && !loading
    && !(extraMode === "json" && extraJsonIssue)
    && !(reasoningMode === "json" && reasoningJsonIssue)
    && !(
      compactThresholdsMode === "json" && compactThresholdsJsonIssue
    )
    && !(aliasMode === "json" && aliasJsonIssue)
    && !(mappingMode === "json" && mappingJsonIssue)
    && !modelRefreshIntervalIssue
    && !sessionAffinityRetentionIssue
    && !providersIssue

  const isDirty = useMemo(
    () => toComparableDraftJson(draft) !== initialDraftJson,
    [draft, initialDraftJson],
  )

  const legacyAuthNote = t("settingsPage.general.legacyAuthNote", {
    env: "COPILOT_API_KEY",
  })

  const smallModelLabel = hasModels
    ? t("settingsPage.general.smallModel")
    : t("settingsPage.general.smallModelManual")
  const smallModelInputValue = draft.smallModel ?? ""
  const authApiKeysValue = getAuthApiKeysFromConfig(draft).join("\n")
  const anthropicApiKeyValue = draft.anthropicApiKey ?? ""
  const anthropicApiKeyEnvNote = t(
    "settingsPage.general.anthropicApiKeyEnvNote",
    { env: "ANTHROPIC_API_KEY" },
  )

  const accountAffinityEnabled = draft.accountAffinity ?? true
  const allowOriginalModelNamesForAliases =
    draft.allowOriginalModelNamesForAliases ?? false

  const persistDevMode = useCallback(
    async (next: DevModeState) => {
      setSaving(true)
      setError(null)

      try {
        const updated = await setDevMode(next)
        setDevModeState(updated)
        toast.success(i18n.t("settingsPage.toast.devModeSaved"))
      } catch (err) {
        const msg = err instanceof AdminApiError ? err.message : String(err)
        setError(msg)
        toast.error(i18n.t("settingsPage.toast.saveDevModeFailed"), {
          description: msg,
        })
      } finally {
        setSaving(false)
      }
    },
    [],
  )

  const handleDevModeEnabledToggle = useCallback(
    (value: boolean) => {
      const next = {
        enabled: value,
        capture4xx: value ? devMode.capture4xx : false,
        capture5xx: value ? devMode.capture5xx : false,
        captureOther: value ? devMode.captureOther : false,
      }
      void persistDevMode(next)
    },
    [devMode.capture4xx, devMode.capture5xx, devMode.captureOther, persistDevMode],
  )

  const handleDevModeCaptureChange = useCallback(
    (field: "capture4xx" | "capture5xx" | "captureOther", value: boolean) => {
      const next = {
        enabled: devMode.enabled,
        capture4xx: devMode.capture4xx,
        capture5xx: devMode.capture5xx,
        captureOther: devMode.captureOther,
        [field]: value,
      }
      void persistDevMode(next)
    },
    [devMode.enabled, devMode.capture4xx, devMode.capture5xx, devMode.captureOther, persistDevMode],
  )
  const forceAgent = draft.forceAgent ?? false
  const compactUseSmallModel = draft.compactUseSmallModel ?? true
  const messageStartInputTokensFallback =
    draft.messageStartInputTokensFallback ?? false
  const useMessagesApi = draft.useMessagesApi ?? true
  const useResponsesApiWebSocket = draft.useResponsesApiWebSocket ?? true
  const useResponsesApiWebSearch = draft.useResponsesApiWebSearch ?? true
  const messageApiWebSearchModelValue = draft.messageApiWebSearchModel ?? ""
  const claudeAutoModelValue = draft.claudeAutoModel ?? ""
  const contextManagement = getContextManagementFromConfig(draft)
  const providerModelSuggestions = deriveProviderModelSuggestions(providersItems)

  return {
    loading,
    saving,
    error,
    configPath,
    canSave,
    isDirty,
    onReload,
    onSave,
    devMode,
    onDevModeEnabledToggle: handleDevModeEnabledToggle,
    onDevModeCaptureChange: handleDevModeCaptureChange,
    hasModels,
    smallModelLabel,
    smallModelValue,
    smallModelInputValue,
    models,
    authApiKeysValue,
    anthropicApiKeyValue,
    legacyAuthNote,
    anthropicApiKeyEnvNote,
    onSmallModelSelect: handleSmallModelSelect,
    onSmallModelInput: handleSmallModelInput,
    onAuthApiKeysChange: handleAuthApiKeysChange,
    onAnthropicApiKeyChange: handleAnthropicApiKeyChange,
    accountAffinityEnabled,
    onAccountAffinityToggle: handleAccountAffinityToggle,
    modelRefreshIntervalInput,
    modelRefreshIntervalIssue,
    sessionAffinityRetentionInput,
    sessionAffinityRetentionIssue,
    onSessionAffinityRetentionChange: handleSessionAffinityRetentionChange,
    onModelRefreshIntervalChange: handleModelRefreshIntervalChange,
    allowOriginalModelNamesForAliases,
    reasoningMode,
    reasoningJson,
    reasoningJsonIssue,
    reasoningItems,
    reasoningSupportByModel,
    reasoningSupportLoaded,
    onReasoningToggleMode,
    onReasoningJsonChange,
    onReasoningAddItem,
    onReasoningRemoveItem,
    onReasoningUpdateItem,
    compactThresholdsMode,
    compactThresholdsJson,
    compactThresholdsJsonIssue,
    compactThresholdsItems,
    providerModelSuggestions,
    onCompactThresholdsToggleMode,
    onCompactThresholdsJsonChange,
    onCompactThresholdsAddItem,
    onCompactThresholdsRemoveItem,
    onCompactThresholdsUpdateItem,
    extraMode,
    extraJson,
    extraJsonIssue,
    extraItems,
    onExtraToggleMode,
    onExtraJsonChange,
    onExtraAddItem,
    onExtraRemoveItem,
    onExtraUpdateItem,
    aliasMode,
    aliasJson,
    aliasJsonIssue,
    aliasItems,
    onAliasToggleMode,
    onAliasJsonChange,
    onAliasAddItem,
    onAliasRemoveItem,
    onAliasUpdateItem,
    mappingMode,
    mappingJson,
    mappingJsonIssue,
    mappingItems,
    onMappingToggleMode,
    onMappingJsonChange,
    onMappingAddItem,
    onMappingRemoveItem,
    onMappingUpdateItem,
    forceAgent,
    compactUseSmallModel,
    messageStartInputTokensFallback,
    useMessagesApi,
    useResponsesApiWebSocket,
    useResponsesApiWebSearch,
    messageApiWebSearchModelValue,
    claudeAutoModelValue,
    contextManagementMessages: contextManagement.messages,
    contextManagementResponses: contextManagement.responses,
    responsesApiContextManagementModelsValue,
    onUseMessagesApiToggle: handleUseMessagesApiToggle,
    onUseResponsesApiWebSocketToggle: handleUseResponsesApiWebSocketToggle,
    onUseResponsesApiWebSearchToggle: handleUseResponsesApiWebSearchToggle,
    onMessageApiWebSearchModelChange: handleMessageApiWebSearchModelChange,
    onClaudeAutoModelChange: handleClaudeAutoModelChange,
    onContextManagementMessagesToggle: handleContextManagementMessagesToggle,
    onContextManagementResponsesToggle: handleContextManagementResponsesToggle,
    onResponsesApiContextManagementModelsChange:
      handleResponsesApiContextManagementModelsChange,
    providersItems,
    providersIssue,
    onProvidersAddProvider,
    onProvidersQuickAddProvider,
    onProvidersRemoveProvider,
    onProvidersUpdateProvider,
    onProvidersAddModel,
    onProvidersRemoveModel,
    onProvidersUpdateModel,
    onAllowOriginalModelNamesForAliasesToggle:
      handleAllowOriginalModelNamesForAliasesToggle,
    onForceAgentToggle: handleForceAgentToggle,
    onCompactUseSmallModelToggle: handleCompactUseSmallModelToggle,
    onMessageStartInputTokensFallbackToggle:
      handleMessageStartInputTokensFallbackToggle,
  }
}

function SettingsPageView({
  loading,
  saving,
  error,
  configPath,
  canSave,
  isDirty,
  onReload,
  onSave,
  devMode,
  onDevModeEnabledToggle,
  onDevModeCaptureChange,
  hasModels,
  smallModelLabel,
  smallModelValue,
  smallModelInputValue,
  models,
  authApiKeysValue,
  anthropicApiKeyValue,
  legacyAuthNote,
  anthropicApiKeyEnvNote,
  onSmallModelSelect,
  onSmallModelInput,
  onAuthApiKeysChange,
  onAnthropicApiKeyChange,
  accountAffinityEnabled,
  onAccountAffinityToggle,
  modelRefreshIntervalInput,
  modelRefreshIntervalIssue,
  sessionAffinityRetentionInput,
  sessionAffinityRetentionIssue,
  onSessionAffinityRetentionChange,
  onModelRefreshIntervalChange,
  reasoningMode,
  reasoningJson,
  reasoningJsonIssue,
  reasoningItems,
  reasoningSupportByModel,
  reasoningSupportLoaded,
  onReasoningToggleMode,
  onReasoningJsonChange,
  onReasoningAddItem,
  onReasoningRemoveItem,
  onReasoningUpdateItem,
  compactThresholdsMode,
  compactThresholdsJson,
  compactThresholdsJsonIssue,
  compactThresholdsItems,
  providerModelSuggestions,
  onCompactThresholdsToggleMode,
  onCompactThresholdsJsonChange,
  onCompactThresholdsAddItem,
  onCompactThresholdsRemoveItem,
  onCompactThresholdsUpdateItem,
  extraMode,
  extraJson,
  extraJsonIssue,
  extraItems,
  onExtraToggleMode,
  onExtraJsonChange,
  onExtraAddItem,
  onExtraRemoveItem,
  onExtraUpdateItem,
  aliasMode,
  aliasJson,
  aliasJsonIssue,
  aliasItems,
  onAliasToggleMode,
  onAliasJsonChange,
  onAliasAddItem,
  onAliasRemoveItem,
  onAliasUpdateItem,
  mappingMode,
  mappingJson,
  mappingJsonIssue,
  mappingItems,
  onMappingToggleMode,
  onMappingJsonChange,
  onMappingAddItem,
  onMappingRemoveItem,
  onMappingUpdateItem,
  allowOriginalModelNamesForAliases,
  forceAgent,
  compactUseSmallModel,
  messageStartInputTokensFallback,
  useMessagesApi,
  useResponsesApiWebSocket,
  useResponsesApiWebSearch,
  messageApiWebSearchModelValue,
  claudeAutoModelValue,
  contextManagementMessages,
  contextManagementResponses,
  responsesApiContextManagementModelsValue,
  onUseMessagesApiToggle,
  onUseResponsesApiWebSocketToggle,
  onUseResponsesApiWebSearchToggle,
  onMessageApiWebSearchModelChange,
  onClaudeAutoModelChange,
  onContextManagementMessagesToggle,
  onContextManagementResponsesToggle,
  onResponsesApiContextManagementModelsChange,
  providersItems,
  providersIssue,
  onProvidersAddProvider,
  onProvidersQuickAddProvider,
  onProvidersRemoveProvider,
  onProvidersUpdateProvider,
  onProvidersAddModel,
  onProvidersRemoveModel,
  onProvidersUpdateModel,
  onAllowOriginalModelNamesForAliasesToggle,
  onForceAgentToggle,
  onCompactUseSmallModelToggle,
  onMessageStartInputTokensFallbackToggle,
}: SettingsPageViewProps): React.JSX.Element {
  const { t } = useTranslation()

  const sections = useMemo<Array<SettingsSection>>(() => {
    return [
      { id: "general", label: t("settingsPage.sections.general") },
      { id: "reasoning", label: t("settingsPage.sections.reasoning") },
      { id: "responsesApi", label: t("settingsPage.sections.responsesApi") },
      { id: "aliases", label: t("settingsPage.sections.aliases") },
      { id: "mappings", label: t("settingsPage.sections.mappings") },
      { id: "prompts", label: t("settingsPage.sections.prompts") },
      { id: "advanced", label: t("settingsPage.sections.advanced") },
      { id: "providers", label: t("settingsPage.sections.providers") },
      { id: "devMode", label: t("settingsPage.sections.devMode") },
    ]
  }, [t])

  const { activeSection, registerSection, scrollToSection } = useActiveSection({
    sectionIds: [...SETTINGS_SECTION_IDS],
  })

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="text-lg font-semibold">{t("nav.settings")}</div>
          <div className="text-muted-foreground text-sm">{t("settingsPage.subtitle")}</div>
        </div>

        <div className="ml-auto flex flex-col items-end gap-1 text-right">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReload}
              disabled={loading || saving}
            >
              {loading ? t("common.refreshing") : t("common.refresh")}
            </Button>
          </div>
          {configPath ? (
            <div className="text-muted-foreground text-xs leading-tight hidden sm:block">
              {t("settingsPage.configPath", { path: configPath })}
            </div>
          ) : null}
          <div className="text-muted-foreground text-xs leading-tight hidden sm:block">
            {t("settingsPage.note")}
          </div>
        </div>
      </div>

      {error ? (
        <InlineAlert
          variant="error"
          title={t("settingsPage.errorTitle")}
          description={error}
          actionLabel={t("common.retry")}
          onAction={onReload}
        />
      ) : null}

      {/* Mobile section navigation */}
      <nav
        className="flex gap-1 overflow-x-auto pb-2 lg:hidden"
        aria-label={t("settingsPage.navigation.ariaLabel")}
      >
        {sections.map((section) => {
          const isActive = activeSection === section.id
          return (
            <button
              key={section.id}
              type="button"
              aria-current={isActive ? "true" : undefined}
              onClick={() => scrollToSection(section.id)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {section.label}
            </button>
          )
        })}
      </nav>

      {/* Main Layout: Sidebar Navigation + Content */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Sidebar Navigation (desktop only) */}
        <aside className="hidden lg:block lg:col-span-2">
          <SettingsNavigation
            sections={sections}
            activeSection={activeSection}
            onSectionClick={scrollToSection}
          />
        </aside>

        {/* Content Area */}
        {loading && !error ? (
          <div className="space-y-6 lg:col-span-10" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
                <div className="h-5 w-32 rounded bg-muted animate-pulse" />
                <div className="h-3 w-48 rounded bg-muted animate-pulse" />
                <div className="space-y-2 pt-2">
                  <div className="h-9 rounded bg-muted animate-pulse" />
                  <div className="h-9 rounded bg-muted animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <main className={cn("space-y-6 lg:col-span-10", loading && "hidden")}>
          {/* General Settings */}
          <SettingsSectionCard
            id="general"
            isActive={activeSection === "general"}
            ref={(el) => registerSection("general", el)}
            style={{ animationDelay: "0ms" }}
          >
            <GeneralSettingsCard
              hasModels={hasModels}
              smallModelLabel={smallModelLabel}
              smallModelValue={smallModelValue}
              smallModelInputValue={smallModelInputValue}
              models={models}
              authApiKeysValue={authApiKeysValue}
              anthropicApiKeyValue={anthropicApiKeyValue}
              legacyAuthNote={legacyAuthNote}
              anthropicApiKeyEnvNote={anthropicApiKeyEnvNote}
              onSmallModelSelect={onSmallModelSelect}
              onSmallModelInput={onSmallModelInput}
              onAuthApiKeysChange={onAuthApiKeysChange}
              onAnthropicApiKeyChange={onAnthropicApiKeyChange}
            />
          </SettingsSectionCard>

          {/* Reasoning Efforts */}
          <SettingsSectionCard
            id="reasoning"
            isActive={activeSection === "reasoning"}
            ref={(el) => registerSection("reasoning", el)}
            style={{ animationDelay: "60ms" }}
          >
            <ReasoningEffortsCard
              mode={reasoningMode}
              json={reasoningJson}
              jsonIssue={reasoningJsonIssue}
              items={reasoningItems}
              models={models}
              reasoningSupportByModel={reasoningSupportByModel}
              reasoningSupportLoaded={reasoningSupportLoaded}
              onToggleMode={onReasoningToggleMode}
              onJsonChange={onReasoningJsonChange}
              onAddItem={onReasoningAddItem}
              onRemoveItem={onReasoningRemoveItem}
              onUpdateItem={onReasoningUpdateItem}
            />
          </SettingsSectionCard>

          {/* Responses API */}
          <SettingsSectionCard
            id="responsesApi"
            isActive={activeSection === "responsesApi"}
            ref={(el) => registerSection("responsesApi", el)}
            style={{ animationDelay: "90ms" }}
          >
            <ResponsesApiSettingsCard
              useResponsesApiWebSocket={useResponsesApiWebSocket}
              useResponsesApiWebSearch={useResponsesApiWebSearch}
              messageApiWebSearchModelValue={messageApiWebSearchModelValue}
              claudeAutoModelValue={claudeAutoModelValue}
              contextManagementMessages={contextManagementMessages}
              contextManagementResponses={contextManagementResponses}
              responsesApiContextManagementModelsValue={
                responsesApiContextManagementModelsValue
              }
              compactThresholdsMode={compactThresholdsMode}
              compactThresholdsJson={compactThresholdsJson}
              compactThresholdsJsonIssue={compactThresholdsJsonIssue}
              compactThresholdsItems={compactThresholdsItems}
              models={models}
              providerModelSuggestions={providerModelSuggestions}
              onToggleUseResponsesApiWebSocket={onUseResponsesApiWebSocketToggle}
              onToggleUseResponsesApiWebSearch={onUseResponsesApiWebSearchToggle}
              onMessageApiWebSearchModelChange={onMessageApiWebSearchModelChange}
              onClaudeAutoModelChange={onClaudeAutoModelChange}
              onToggleContextManagementMessages={
                onContextManagementMessagesToggle
              }
              onToggleContextManagementResponses={
                onContextManagementResponsesToggle
              }
              onResponsesApiContextManagementModelsChange={
                onResponsesApiContextManagementModelsChange
              }
              onCompactThresholdsToggleMode={onCompactThresholdsToggleMode}
              onCompactThresholdsJsonChange={onCompactThresholdsJsonChange}
              onCompactThresholdsAddItem={onCompactThresholdsAddItem}
              onCompactThresholdsRemoveItem={onCompactThresholdsRemoveItem}
              onCompactThresholdsUpdateItem={onCompactThresholdsUpdateItem}
            />
          </SettingsSectionCard>

          {/* Model Aliases */}
          <SettingsSectionCard
            id="aliases"
            isActive={activeSection === "aliases"}
            ref={(el) => registerSection("aliases", el)}
            style={{ animationDelay: "120ms" }}
          >
            <ModelAliasesCard
              allowOriginalModelNamesForAliases={allowOriginalModelNamesForAliases}
              mode={aliasMode}
              json={aliasJson}
              jsonIssue={aliasJsonIssue}
              items={aliasItems}
              models={models}
              onToggleMode={onAliasToggleMode}
              onJsonChange={onAliasJsonChange}
              onAddItem={onAliasAddItem}
              onRemoveItem={onAliasRemoveItem}
              onUpdateItem={onAliasUpdateItem}
            />
          </SettingsSectionCard>

          {/* Model Mappings */}
          <SettingsSectionCard
            id="mappings"
            isActive={activeSection === "mappings"}
            ref={(el) => registerSection("mappings", el)}
            style={{ animationDelay: "150ms" }}
          >
            <ModelMappingsCard
              mode={mappingMode}
              json={mappingJson}
              jsonIssue={mappingJsonIssue}
              items={mappingItems}
              onToggleMode={onMappingToggleMode}
              onJsonChange={onMappingJsonChange}
              onAddItem={onMappingAddItem}
              onRemoveItem={onMappingRemoveItem}
              onUpdateItem={onMappingUpdateItem}
            />
          </SettingsSectionCard>

          {/* Extra Prompts */}
          <SettingsSectionCard
            id="prompts"
            isActive={activeSection === "prompts"}
            ref={(el) => registerSection("prompts", el)}
            style={{ animationDelay: "180ms" }}
          >
            <ExtraPromptsCard
              mode={extraMode}
              json={extraJson}
              jsonIssue={extraJsonIssue}
              items={extraItems}
              models={models}
              onToggleMode={onExtraToggleMode}
              onJsonChange={onExtraJsonChange}
              onAddItem={onExtraAddItem}
              onRemoveItem={onExtraRemoveItem}
              onUpdateItem={onExtraUpdateItem}
            />
          </SettingsSectionCard>

          {/* Advanced Settings */}
          <SettingsSectionCard
            id="advanced"
            isActive={activeSection === "advanced"}
            ref={(el) => registerSection("advanced", el)}
            style={{ animationDelay: "240ms" }}
          >
            <AdvancedSettingsCard
              accountAffinityEnabled={accountAffinityEnabled}
              modelRefreshIntervalInput={modelRefreshIntervalInput}
              modelRefreshIntervalIssue={modelRefreshIntervalIssue}
              sessionAffinityRetentionInput={sessionAffinityRetentionInput}
              sessionAffinityRetentionIssue={sessionAffinityRetentionIssue}
              allowOriginalModelNamesForAliases={
                allowOriginalModelNamesForAliases
              }
              forceAgent={forceAgent}
              compactUseSmallModel={compactUseSmallModel}
              messageStartInputTokensFallback={messageStartInputTokensFallback}
              useMessagesApi={useMessagesApi}
              onToggleAccountAffinity={onAccountAffinityToggle}
              onModelRefreshIntervalChange={onModelRefreshIntervalChange}
              onSessionAffinityRetentionChange={
                onSessionAffinityRetentionChange
              }
              onToggleAllowOriginalModelNamesForAliases={
                onAllowOriginalModelNamesForAliasesToggle
              }
              onToggleForceAgent={onForceAgentToggle}
              onToggleCompactUseSmallModel={onCompactUseSmallModelToggle}
              onToggleMessageStartInputTokensFallback={
                onMessageStartInputTokensFallbackToggle
              }
              onToggleUseMessagesApi={onUseMessagesApiToggle}
            />
          </SettingsSectionCard>

          {/* Providers */}
          <SettingsSectionCard
            id="providers"
            isActive={activeSection === "providers"}
            ref={(el) => registerSection("providers", el)}
            style={{ animationDelay: "300ms" }}
          >
            <ProvidersSettingsCard
              items={providersItems}
              issue={providersIssue}
              onAddProvider={onProvidersAddProvider}
              onQuickAddProvider={onProvidersQuickAddProvider}
              onRemoveProvider={onProvidersRemoveProvider}
              onUpdateProvider={onProvidersUpdateProvider}
              onAddModel={onProvidersAddModel}
              onRemoveModel={onProvidersRemoveModel}
              onUpdateModel={onProvidersUpdateModel}
            />
          </SettingsSectionCard>

          {/* Developer Mode */}
          <SettingsSectionCard
            id="devMode"
            isActive={activeSection === "devMode"}
            ref={(el) => registerSection("devMode", el)}
            style={{ animationDelay: "360ms" }}
          >
            <DeveloperModeCard
              devMode={devMode}
              saving={saving}
              onToggleEnabled={onDevModeEnabledToggle}
              onCaptureChange={onDevModeCaptureChange}
            />
          </SettingsSectionCard>
        </main>
      </div>

      {/* Floating Save Button */}
      {(isDirty || saving) ? (
        <FloatingSaveButton
          saving={saving}
          canSave={canSave}
          onSave={onSave}
        />
      ) : null}
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const state = useSettingsPageState()
  return <SettingsPageView {...state} />
}
