import { readAdminToken } from "@/lib/admin-token"

import type { SSEEvent } from "./sse"

export const ADMIN_TOKEN_REQUIRED_EVENT = "admin-ui:admin-token-required"

// Wire types from backend (SQLite 0/1/null)
type AdminRequestItemWire = {
  request_id: string
  started_at_ms?: number
  http_status: number
  duration_ms?: number
  ttfb_ms?: number

  path: string
  upstream_endpoint?: string
  upstream_model?: string
  client_model?: string
  account_id?: string

  cost_units?: number
  credits_consumed?: number
  premium_unlimited_after?: boolean | number | null
  premium_unlimited_before?: boolean | number | null
  premium_remaining_after?: number
  premium_remaining_before?: number
  premium_remaining_diff?: number
  credits_unlimited_after?: boolean | number | null
  credits_unlimited_before?: boolean | number | null
  credits_remaining_after?: number
  credits_remaining_before?: number
  credits_remaining_diff?: number

  tokens_input?: number
  tokens_output?: number
  tokens_total?: number
  tokens_cached_input?: number

  client_ip?: string
  user_agent?: string

  user_id?: string
  safety_identifier?: string
  prompt_cache_key?: string
  initiator?: string
  is_subagent?: number | null
  upstream_request_id?: string
  outbound_x_request_id?: string
  outbound_x_agent_task_id?: string
  outbound_x_interaction_id?: string | null
  outbound_x_interaction_type?: string
  outbound_openai_intent?: string
  outbound_user_agent?: string

  affinity_hit?: number | null
  affinity_cache_key?: string | null
  affinity_key_used?: string | null
  affinity_key_source?: string | null
  selection_reason?: string | null
  responses_item_owner_lookup_keys_json?: string | null
  responses_item_owner_recorded_keys_json?: string | null
  upstream_error_message_raw?: string | null

  has_outbound?: boolean

  error?: unknown
}

// UI-facing type with normalized boolean semantics
export type AdminRequestItem = Omit<
  AdminRequestItemWire,
  | "is_subagent"
  | "credits_unlimited_after"
  | "credits_unlimited_before"
> & {
  is_subagent?: boolean | null
  credits_consumed?: number
  credits_unlimited_after?: boolean | null
  credits_unlimited_before?: boolean | null
}

function normalizeNullableBool(value: boolean | number | null | undefined): boolean | null {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return null
}

type AdminRequestCreditsWire = Pick<
  AdminRequestItemWire,
  | "cost_units"
  | "credits_consumed"
  | "premium_remaining_before"
  | "premium_remaining_after"
  | "premium_remaining_diff"
  | "premium_unlimited_before"
  | "premium_unlimited_after"
  | "credits_remaining_before"
  | "credits_remaining_after"
  | "credits_remaining_diff"
  | "credits_unlimited_before"
  | "credits_unlimited_after"
>

function normalizeAdminRequestCredits(
  wire: AdminRequestCreditsWire,
): Pick<
  AdminRequestItem,
  | "credits_consumed"
  | "credits_remaining_before"
  | "credits_remaining_after"
  | "credits_remaining_diff"
  | "credits_unlimited_before"
  | "credits_unlimited_after"
> {
  return {
    credits_consumed: wire.credits_consumed ?? wire.cost_units,
    credits_remaining_before:
      wire.credits_remaining_before ?? wire.premium_remaining_before,
    credits_remaining_after:
      wire.credits_remaining_after ?? wire.premium_remaining_after,
    credits_remaining_diff:
      wire.credits_remaining_diff ?? wire.premium_remaining_diff,
    credits_unlimited_before: normalizeNullableBool(
      wire.credits_unlimited_before ?? wire.premium_unlimited_before,
    ),
    credits_unlimited_after: normalizeNullableBool(
      wire.credits_unlimited_after ?? wire.premium_unlimited_after,
    ),
  }
}

export function normalizeAdminRequestItem(
  wire: AdminRequestItemWire,
): AdminRequestItem {
  const {
    is_subagent,
    credits_unlimited_after: _creditsUnlimitedAfter,
    credits_unlimited_before: _creditsUnlimitedBefore,
    ...rest
  } = wire

  void _creditsUnlimitedAfter
  void _creditsUnlimitedBefore

  return {
    ...rest,
    ...normalizeAdminRequestCredits(wire),
    is_subagent: normalizeNullableBool(is_subagent),
  }
}

export type AdminMeta = {
  userVersion?: number
  dbPath?: string
}

export type AdminAccountItemWire = {
  account_id: string
  account_type?: string
  runtime?: {
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

export type AdminAccountItem = AdminAccountItemWire

function normalizeAdminAccountRuntime(
  runtime: NonNullable<AdminAccountItemWire["runtime"]>,
): NonNullable<AdminAccountItem["runtime"]> {
  return {
    ...runtime,
    creditsEntitlement: runtime.creditsEntitlement ?? runtime.entitlement,
    creditsRemaining: runtime.creditsRemaining ?? runtime.remaining,
    creditsUnlimited: runtime.creditsUnlimited ?? runtime.unlimited,
  }
}

export function normalizeAdminAccountItem(
  wire: AdminAccountItemWire,
): AdminAccountItem {
  const runtime = wire.runtime
  if (!runtime) return wire

  return {
    ...wire,
    runtime: normalizeAdminAccountRuntime(runtime),
  }
}

export type AdminAccountsResponse = {
  items: AdminAccountItem[]
}

export type AdminRequestsResponse = {
  items: AdminRequestItem[]
  next_cursor_id?: number | null
  has_more: boolean
}

export type AdminRequestDetailResponse = {
  item: AdminRequestItem | null
  has_outbound?: boolean
}

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type ModelAliasSpec = {
  target: string
  allowOriginal?: boolean
}

export type ProviderType = "anthropic" | "openai-compatible" | "openai-responses"

export type ProviderAuthType = "authorization" | "oauth2" | "x-api-key"

export type ToolContentSupportType = "array" | "image" | "pdf"

export type TokenUsagePricingTier = {
  cachedInput?: number
  cacheCreationInput?: number
  explicitCachedInput?: number
  input?: number
  maxInputTokens?: number
  output?: number
}

export type TokenUsagePricingConfig = TokenUsagePricingTier & {
  tiers?: Array<TokenUsagePricingTier>
}

export type ProviderModelConfig = {
  temperature?: number
  topP?: number
  topK?: number
  type?: ProviderType
  extraBody?: Record<string, unknown>
  contextCache?: boolean
  pricing?: TokenUsagePricingConfig
  supportPdf?: boolean
  toolContentSupportType?: Array<ToolContentSupportType>
}

export type ProviderConfig = {
  type?: ProviderType
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  authType?: ProviderAuthType
  pricingCurrency?: string
  adjustInputTokens?: boolean
  models?: Record<string, ProviderModelConfig>
}

export type TokenUsagePeriod = "day" | "week" | "month"

export type TokenUsageSource = "copilot" | "provider"

export type TokenUsageEndpoint =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "provider_messages"
  | "responses"

export type TokenUsageCost = {
  amount: number
  currency: string
  total_cost_nanos: number
}

export type TokenUsageEventCost = TokenUsageCost & {
  source: string
}

export type TokenUsageTotals = {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  costs: Array<TokenUsageCost>
  input_tokens: number
  output_tokens: number
  request_count: number
  total_nano_aiu: number | null
  total_tokens: number
}

export type TokenUsageModelSummary = TokenUsageTotals & {
  model: string
}

export type TokenUsageRange = {
  end_ms: number
  end_utc: string
  start_ms: number
  start_utc: string
}

export type TokenUsageSummary = {
  byModel: Array<TokenUsageModelSummary>
  period: TokenUsagePeriod
  range: TokenUsageRange
  totals: TokenUsageTotals
}

export type TokenUsageDailyBucket = {
  byModel: Array<TokenUsageModelSummary>
  date: string
  end_ms: number
  start_ms: number
  totals: TokenUsageTotals
}

export type TokenUsageDailySummary = {
  byModel: Array<TokenUsageModelSummary>
  days: Array<TokenUsageDailyBucket>
  period: TokenUsagePeriod
  range: TokenUsageRange
  totals: TokenUsageTotals
}

export type TokenUsageEventRecord = {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost: TokenUsageEventCost | null
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  id: number
  input_tokens: number
  model: string
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  total_nano_aiu: number | null
  total_tokens: number
  trace_id: string
  user_id: string
}

export type TokenUsageEventsPage = {
  items: Array<TokenUsageEventRecord>
  page: number
  page_size: number
  period: TokenUsagePeriod
  range: TokenUsageRange
  total: number
  total_pages: number
}

export type AdminConfig = {
  auth?: {
    apiKeys?: Array<string>
  }
  providers?: Record<string, ProviderConfig>
  extraPrompts?: Record<string, string>
  smallModel?: string
  accountAffinity?: boolean
  /** @deprecated */
  apiKey?: string
  anthropicApiKey?: string
  /** @deprecated use contextManagement */
  responsesApiContextManagementModels?: Array<string>
  contextManagement?: {
    messages?: boolean
    responses?: boolean
  }
  modelReasoningEfforts?: Record<string, ReasoningEffort>
  modelResponsesApiCompactThresholds?: Record<string, number>
  modelAliases?: Record<string, ModelAliasSpec | string>
  modelMappings?: Record<string, string>
  allowOriginalModelNamesForAliases?: boolean
  forceAgent?: boolean
  compactUseSmallModel?: boolean
  messageStartInputTokensFallback?: boolean
  modelRefreshIntervalHours?: number
  sessionAffinityRetentionDays?: number
  useMessagesApi?: boolean
  useResponsesApiWebSocket?: boolean
  useResponsesApiWebSearch?: boolean
  messageApiWebSearchModel?: string
  /** @deprecated use contextManagement */
  useResponsesApiContextManagement?: boolean
  copilotUseLocalModels?: boolean
}

export type AdminConfigResponse = AdminConfig & {
  _configPath?: string
}

export type AdminModelsResponse = {
  items: string[]
}

export type AggregatedModelItem = Record<string, unknown> & {
  id: string
  object: string
  type?: string
  created?: number
  created_at?: string
  owned_by?: string
  display_name?: string
  claude_model_id?: string
}

export type AggregatedModelsResponse = {
  object: "list"
  data: Array<AggregatedModelItem>
  has_more: boolean
}

export type AdminModelTokenPrices = {
  batch_size?: number
  cache_price?: number
  input_price?: number
  output_price?: number
}

export type AdminModelDetailsItem = {
  id: string
  name: string
  preview: boolean
  billing?: {
    is_premium?: boolean
    multiplier?: number
    token_based?: boolean
    tokenBasedBilling?: boolean
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

export type AdminModelsDetailsResponse = {
  items: Array<AdminModelDetailsItem>
}

function normalizeAdminModelBilling(
  billing: NonNullable<AdminModelDetailsItem["billing"]>,
): NonNullable<AdminModelDetailsItem["billing"]> {
  const prices = billing.token_prices
  const hasTokenPrice =
    prices !== undefined &&
    [prices.cache_price, prices.input_price, prices.output_price].some(
      (price) => typeof price === "number" && Number.isFinite(price),
    )

  return {
    ...billing,
    tokenBasedBilling:
      billing.tokenBasedBilling ?? billing.token_based ?? (hasTokenPrice ? true : undefined),
  }
}

export function normalizeAdminModelDetailsItem(
  item: AdminModelDetailsItem,
): AdminModelDetailsItem {
  const billing = item.billing
  if (!billing) return item

  return {
    ...item,
    billing: normalizeAdminModelBilling(billing),
  }
}

export type DailyStatsItemWire = {
  date: string
  request_count: number
  premium_consumed?: number
  credits_consumed?: number
  tokens_total: number
  error_count: number
}

export type DailyStatsItem = DailyStatsItemWire & {
  premium_consumed: number
  credits_consumed: number
}

export type DailyAccountStatsItemWire = DailyStatsItemWire & {
  account_id: string
}

export type DailyAccountStatsItem = DailyStatsItem & {
  account_id: string
}

export type PremiumStatsResponseWire = {
  daily: Array<DailyStatsItemWire>
  by_account: Array<DailyAccountStatsItemWire>
  range: { from: string; to: string; granularity: "day" | "hour" }
}

export type PremiumStatsResponse = {
  daily: Array<DailyStatsItem>
  by_account: Array<DailyAccountStatsItem>
  range: { from: string; to: string; granularity: "day" | "hour" }
}

export function getCreditsConsumed(
  wire: Pick<DailyStatsItemWire, "credits_consumed" | "premium_consumed">,
): number {
  return wire.credits_consumed ?? wire.premium_consumed ?? 0
}

export function normalizeDailyStatsItem(wire: DailyStatsItemWire): DailyStatsItem {
  const creditsConsumed = getCreditsConsumed(wire)
  return {
    ...wire,
    premium_consumed: wire.premium_consumed ?? creditsConsumed,
    credits_consumed: creditsConsumed,
  }
}

export function normalizeDailyAccountStatsItem(
  wire: DailyAccountStatsItemWire,
): DailyAccountStatsItem {
  return {
    ...normalizeDailyStatsItem(wire),
    account_id: wire.account_id,
  }
}

export type DevModeState = {
  enabled: boolean
  capture4xx: boolean
  capture5xx: boolean
  captureOther: boolean
}

export type OutboundBlob = {
  request_id: string
  captured_at_ms: number
  http_status: number
  upstream_url: string
  upstream_method: string
  request_headers: Record<string, string>
  request_body: string | null
  request_body_kind: "json" | "text" | "binary"
  response_status: number
  response_headers: Record<string, string>
  response_body: string | null
  response_body_kind: "json" | "sse" | "text"
  redacted_header_keys: Array<string>
  original: {
    path: string
    upstream_endpoint: string | null
    upstream_model: string | null
    account_id: string | null
    client_model: string | null
  } | null
}

export type ReplayRequest = {
  accountId: string
  overrides?: {
    body?: string
    headers?: Record<string, string>
  }
  mode: "collect" | "live"
}

export type ReplayCollectResult = {
  status: number
  statusText: string
  headers: Record<string, string>
  raw: { body: string; kind: "json" | "sse" | "text" }
  translated: unknown
  durationMs: number
  replayedAt: number
}

export class AdminApiError extends Error {
  readonly status: number
  readonly responseText: string

  constructor(status: number, responseText: string) {
    super(`HTTP ${status}: ${responseText}`)
    this.name = "AdminApiError"
    this.status = status
    this.responseText = responseText
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function buildAdminHeaders(
  init?: RequestInit,
  overrideToken?: string,
): Headers {
  const token = overrideToken?.trim() ?? readAdminToken()
  const headers = new Headers(init?.headers ?? undefined)

  if (token) {
    headers.set("x-admin-token", token)
  }

  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  return headers
}

async function readAdminError(res: Response): Promise<string> {
  const txt = await res.text().catch(() => "")
  let message = txt

  try {
    const parsed = JSON.parse(txt) as unknown
    if (isPlainObject(parsed) && "error" in parsed) {
      const err = (parsed as { error?: unknown }).error
      if (isPlainObject(err) && typeof (err as { message?: unknown }).message === "string") {
        message = (err as { message: string }).message
      }
    }
  } catch {
    // ignore JSON parsing errors and keep raw text
  }

  if (res.status === 401 || res.status === 403) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(ADMIN_TOKEN_REQUIRED_EVENT))
    }
  }

  return message
}

async function fetchAdminJson<T>(
  path: string,
  init?: RequestInit,
  overrideToken?: string,
): Promise<T> {
  const headers = buildAdminHeaders(init, overrideToken)
  const res = await fetch(path, { ...init, headers })

  if (!res.ok) {
    throw new AdminApiError(res.status, await readAdminError(res))
  }

  return (await res.json()) as T
}

export async function getAdminMeta(overrideToken?: string): Promise<AdminMeta> {
  return fetchAdminJson<AdminMeta>("/api/admin/meta", undefined, overrideToken)
}

export async function getAdminAccounts(params: {
  sinceMs: number
  includeStats?: boolean
}): Promise<AdminAccountsResponse> {
  const q = new URLSearchParams()
  q.set("since_ms", String(params.sinceMs))
  q.set("include_stats", params.includeStats === false ? "0" : "1")
  const response = await fetchAdminJson<{ items: AdminAccountItemWire[] }>(
    `/api/admin/accounts?${q.toString()}`,
  )
  return {
    items: response.items.map(normalizeAdminAccountItem),
  }
}

export async function queryAdminRequests(params: {
  account_id?: string
  upstream_model?: string
  client_model?: string
  upstream_endpoint?: string
  path?: string
  status?: string
  has_error?: string
  from_ms?: string
  to_ms?: string
  limit?: number
  cursor_id?: number | null
}): Promise<AdminRequestsResponse> {
  const q = new URLSearchParams()
  if (params.account_id) q.set("account_id", params.account_id)
  if (params.upstream_model) q.set("upstream_model", params.upstream_model)
  if (params.client_model) q.set("client_model", params.client_model)
  if (params.upstream_endpoint) q.set("upstream_endpoint", params.upstream_endpoint)
  if (params.path) q.set("path", params.path)
  if (params.status) q.set("status", params.status)
  if (params.has_error) q.set("has_error", params.has_error)
  if (params.from_ms) q.set("from_ms", params.from_ms)
  if (params.to_ms) q.set("to_ms", params.to_ms)

  q.set("limit", String(params.limit ?? 50))
  if (params.cursor_id != null) q.set("cursor_id", String(params.cursor_id))

  const response = await fetchAdminJson<{ items: AdminRequestItemWire[]; next_cursor_id?: number | null; has_more: boolean }>(
    `/api/admin/requests?${q.toString()}`
  )

  return {
    ...response,
    items: response.items.map(normalizeAdminRequestItem),
  }
}

export async function getAdminRequestDetail(
  requestId: string
): Promise<AdminRequestDetailResponse> {
  const response = await fetchAdminJson<{
    item: AdminRequestItemWire | null
    has_outbound?: boolean
  }>(`/api/admin/requests/${encodeURIComponent(requestId)}`)

  return {
    item: response.item ? normalizeAdminRequestItem(response.item) : null,
    has_outbound: response.has_outbound,
  }
}

export async function getAdminConfig(): Promise<AdminConfigResponse> {
  return fetchAdminJson<AdminConfigResponse>("/api/admin/config")
}

const ADMIN_CONFIG_KEYS = new Set<keyof AdminConfig>([
  "auth",
  "providers",
  "extraPrompts",
  "smallModel",
  "accountAffinity",
  "apiKey",
  "anthropicApiKey",
  "responsesApiContextManagementModels",
  "contextManagement",
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
])

export async function updateAdminConfig(
  patch: Partial<AdminConfig>
): Promise<AdminConfigResponse> {
  const filtered = Object.fromEntries(
    Object.entries(patch).filter(([k]) => ADMIN_CONFIG_KEYS.has(k as keyof AdminConfig))
  )
  return fetchAdminJson<AdminConfigResponse>("/api/admin/config", {
    method: "POST",
    body: JSON.stringify(filtered),
  })
}

export async function getAdminModels(): Promise<AdminModelsResponse> {
  return fetchAdminJson<AdminModelsResponse>("/api/admin/models")
}

export async function getAdminModelDetails(): Promise<AdminModelsDetailsResponse> {
  const response = await fetchAdminJson<AdminModelsDetailsResponse>(
    "/api/admin/models/details",
  )
  return {
    items: response.items.map(normalizeAdminModelDetailsItem),
  }
}

export async function getAdminAggregatedModels(): Promise<AggregatedModelsResponse> {
  return fetchAdminJson<AggregatedModelsResponse>(
    "/api/admin/models/aggregated",
  )
}

export async function refreshAllModels(): Promise<{
  ok: boolean
  failedCount: number
}> {
  return fetchAdminJson<{ ok: boolean; failedCount: number }>(
    "/api/admin/accounts/models/refresh",
    {
      method: "POST",
    },
  )
}

export async function getAdminPremiumStats(params: {
  from?: string
  to?: string
  accountId?: string
  granularity?: "day" | "hour"
  fromMs?: number
  toMs?: number
}): Promise<PremiumStatsResponse> {
  const q = new URLSearchParams()
  if (params.from) q.set("from", params.from)
  if (params.to) q.set("to", params.to)
  if (params.accountId) q.set("account_id", params.accountId)
  if (params.granularity) q.set("granularity", params.granularity)
  if (params.fromMs != null) q.set("from_ms", String(params.fromMs))
  if (params.toMs != null) q.set("to_ms", String(params.toMs))
  const response = await fetchAdminJson<PremiumStatsResponseWire>(
    `/api/admin/stats/premium-daily?${q.toString()}`,
  )
  return {
    ...response,
    daily: response.daily.map(normalizeDailyStatsItem),
    by_account: response.by_account.map(normalizeDailyAccountStatsItem),
  }
}

export async function getTokenUsageSummary(params: {
  period: TokenUsagePeriod
}): Promise<TokenUsageSummary> {
  const q = new URLSearchParams()
  q.set("period", params.period)
  return fetchAdminJson<TokenUsageSummary>(`/api/admin/token-usage?${q.toString()}`)
}

export async function getTokenUsageDaily(params: {
  period: TokenUsagePeriod
}): Promise<TokenUsageDailySummary> {
  const q = new URLSearchParams()
  q.set("period", params.period)
  return fetchAdminJson<TokenUsageDailySummary>(
    `/api/admin/token-usage/daily?${q.toString()}`,
  )
}

export async function getTokenUsageEvents(params: {
  page: number
  pageSize: number
  period: TokenUsagePeriod
}): Promise<TokenUsageEventsPage> {
  const q = new URLSearchParams()
  q.set("period", params.period)
  q.set("page", String(params.page))
  q.set("page_size", String(params.pageSize))
  return fetchAdminJson<TokenUsageEventsPage>(
    `/api/admin/token-usage/events?${q.toString()}`,
  )
}

export async function getDevMode(): Promise<DevModeState> {
  return fetchAdminJson<DevModeState>("/api/admin/dev-mode")
}

export async function setDevMode(
  patch: Partial<DevModeState>,
): Promise<DevModeState> {
  return fetchAdminJson<DevModeState>("/api/admin/dev-mode", {
    method: "POST",
    body: JSON.stringify(patch),
  })
}

export async function getRequestOutbound(
  requestId: string,
): Promise<OutboundBlob> {
  return fetchAdminJson<OutboundBlob>(
    `/api/admin/requests/${encodeURIComponent(requestId)}/outbound`,
  )
}

export async function replayCollect(
  requestId: string,
  req: Omit<ReplayRequest, "mode">,
): Promise<ReplayCollectResult> {
  return fetchAdminJson<ReplayCollectResult>(
    `/api/admin/requests/${encodeURIComponent(requestId)}/replay`,
    {
      method: "POST",
      body: JSON.stringify({ ...req, mode: "collect" }),
    },
  )
}

export async function replayLive(
  requestId: string,
  req: Omit<ReplayRequest, "mode">,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers = buildAdminHeaders(
    {
      body: JSON.stringify({ ...req, mode: "live" }),
      headers: { "content-type": "application/json" },
    },
  )
  const res = await fetch(
    `/api/admin/requests/${encodeURIComponent(requestId)}/replay`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ ...req, mode: "live" }),
      signal,
    },
  )

  if (!res.ok || !res.body) {
    throw new AdminApiError(
      res.status,
      !res.ok ? await readAdminError(res) : "Response body is missing",
    )
  }

  const { parseSSEStream } = await import("./sse")
  await parseSSEStream(res.body.getReader(), onEvent, signal)
}

// --- Account Management Types ---

export type AccountType = "individual" | "business" | "enterprise"

export type AuthStartRequest = {
  accountType: AccountType
  enterpriseDomain?: string
}

export type AuthStartResponse = {
  sessionId: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type AuthStatusResponse = {
  status: "pending" | "completed" | "failed" | "expired"
  accountId?: string
  error?: string
}

// --- Account Management API Functions ---

export async function startAccountAuth(
  params: AuthStartRequest,
): Promise<AuthStartResponse> {
  return fetchAdminJson<AuthStartResponse>("/api/admin/accounts/auth/start", {
    method: "POST",
    body: JSON.stringify(params),
  })
}

export async function getAuthStatus(
  sessionId: string,
): Promise<AuthStatusResponse> {
  return fetchAdminJson<AuthStatusResponse>(
    `/api/admin/accounts/auth/status/${encodeURIComponent(sessionId)}`,
  )
}

export async function cancelAuth(
  sessionId: string,
): Promise<{ cancelled: boolean }> {
  return fetchAdminJson<{ cancelled: boolean }>(
    `/api/admin/accounts/auth/cancel/${encodeURIComponent(sessionId)}`,
    { method: "POST" },
  )
}

export async function deleteAccount(
  accountId: string,
): Promise<{ deleted: boolean; accountId: string }> {
  return fetchAdminJson<{ deleted: boolean; accountId: string }>(
    `/api/admin/accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  )
}

export async function reauthAccount(
  accountId: string,
): Promise<AuthStartResponse> {
  return fetchAdminJson<AuthStartResponse>(
    `/api/admin/accounts/${encodeURIComponent(accountId)}/reauth`,
    { method: "POST" },
  )
}

export async function patchAccount(
  accountId: string,
  patch: { enabled: boolean },
): Promise<{ success: true }> {
  return fetchAdminJson<{ success: true }>(
    `/api/admin/accounts/${encodeURIComponent(accountId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  )
}
