/* eslint-disable max-lines */
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import type { SubagentMarker } from "~/lib/subagent"
import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

import {
  accountsManager,
  type AccountSelectionReason,
} from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  getProviderConfig,
  getSmallModel,
  isMessageStartInputTokensFallbackEnabled,
  isMessagesApiEnabled,
  resolveModelAlias,
  shouldCompactUseSmallModel,
} from "~/lib/config"
import {
  computeDiff,
  extractErrorObservability,
  getUserVisibleErrorMessage,
  shouldMarkAccountFailed,
  toAccountContext,
} from "~/lib/handler-utils"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { resolveExistingProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  extractResponsesUsageFromResult,
  extractResponsesUsageFromStreamEvent,
  getClientIpInfo,
  getRequestHistoryStore,
  normalizeChatCompletionsUsage,
  normalizeMessagesUsage,
  type NormalizedUsage,
} from "~/lib/request-history"
import { resolveEffectiveInitiator } from "~/lib/request-initiator"
import { state } from "~/lib/state"
import {
  type AffinityKeySource,
  generateRequestIdFromPayload,
  getRootSessionId,
  normalizeStableSessionId,
  parseUserIdMetadata,
  resolveAffinityKey,
} from "~/lib/utils"
import {
  extractAnthropicResponsesItemOwnerKeys,
  extractResponsesResultOwnerKeys,
  extractResponsesStreamEventOwnerKeys,
} from "~/routes/messages/responses-item-ownership"
import {
  handleProviderMessagesForProvider,
  type ProviderMessagesInstrumentation,
  type ProviderStreamError,
  type UsageTokens,
} from "~/routes/provider/messages/handler"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
  getResponsesTransportForModel,
} from "~/routes/responses/utils"
import { flushPendingCapture } from "~/services/copilot/copilot-fetch"
import {
  createChatCompletions,
  getChatInitiator,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createMessages,
  getMessagesInitiator,
} from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  applyLastMessageCacheControl,
  getCompactType,
  getLastMessageContentCacheControl,
  mergeToolResultForClaude,
  normalizeSystemMessages,
  prepareMessagesApiPayload,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import { inspectSubagentMarkerFromFirstUser } from "./subagent-marker"
import {
  estimateInputTokens,
  handleSelectionFailure,
  isWarmupProbeRequest,
  maybeBlockOriginalModelName,
} from "./utils"

const logger = createHandlerLogger("messages-handler")

const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const getProviderConfigResolver = (c: Context): typeof getProviderConfig => {
  const resolver = c.get("providerConfigResolver" as never) as
    | typeof getProviderConfig
    | undefined
  return resolver ?? getProviderConfig
}

const resolveProviderTargetModelAlias = (
  model: string,
  providerConfigResolver: typeof getProviderConfig,
) => {
  const targetModel = resolveModelAlias(model)
  if (targetModel === model) {
    return null
  }

  return resolveExistingProviderModelAlias(targetModel, providerConfigResolver)
}

type AccountSelection = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type AccountSelectionOk = Extract<AccountSelection, { ok: true }>

type InstrumentationContext = {
  store: ReturnType<typeof getRequestHistoryStore>
  requestId: string
  startedAtMs: number

  method: string
  path: string

  clientIp?: string
  clientIpSource?: string
  userAgent?: string

  userId?: string
  safetyIdentifier?: string
  promptCacheKey?: string
  initiator?: "agent" | "user"
  isSubagent?: boolean
  upstreamRequestId?: string

  /** Call after upstream success to persist affinity mapping. */
  confirmAffinity?: () => void
  /** Call after upstream success to persist ownership mapping. */
  confirmOwnership?: () => void

  affinityHit?: boolean
  affinityCacheKey?: string

  affinityKeyUsed?: string
  affinityKeySource?: AffinityKeySource
  selectionReason?: AccountSelectionReason
  responsesItemOwnerLookupKeys?: ReadonlyArray<string>
  responsesItemOwnerRecordedKeys?: ReadonlyArray<string>

  clientModel: string

  account: AccountRuntime
  reservation: AccountSelectionOk["reservation"]
  upstreamModel: string
  upstreamEndpoint: string
  costUnits: number

  premiumRemainingBefore?: number
  premiumUnlimitedBefore?: boolean
}

function normalizeProviderAliasUsage(usage: UsageTokens): NormalizedUsage {
  const tokensInput =
    usage.inputTokens === undefined ? undefined : Math.max(0, usage.inputTokens)
  const tokensCachedInput = usage.cacheReadInputTokens
  const tokensTotal =
    usage.inputTokens === undefined && usage.outputTokens === undefined ?
      undefined
    : (tokensInput ?? 0)
      + (usage.outputTokens ?? 0)
      + (usage.cacheCreationInputTokens ?? 0)
      + (tokensCachedInput ?? 0)

  return {
    tokensCachedInput,
    tokensInput,
    tokensOutput: usage.outputTokens,
    tokensTotal,
    usageJson: JSON.stringify({
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
    }),
  }
}

async function handleProviderAliasCompletion(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
    providerModel: string
  },
): Promise<Response> {
  const { payload, provider, providerModel } = options
  const requestId = randomUUID()
  const startedAtMs = Date.now()
  const method = c.req.raw.method
  const path = new URL(c.req.url, "http://local").pathname
  const { ip: clientIp, source: clientIpSource } = getClientIpInfo(c)
  const userAgent = c.req.header("user-agent") ?? undefined
  const streamRequested = Boolean(payload.stream)
  const originalModel = payload.model
  const rawUserId = payload.metadata?.user_id
  const userId = typeof rawUserId === "string" ? rawUserId : undefined
  const { safetyIdentifier, sessionId: promptCacheKey } =
    parseUserIdMetadata(userId)
  const markerInspection = inspectSubagentMarkerFromFirstUser(payload)
  const isSubagent = markerInspection.kind === "valid"

  let requestRecorded = false
  const insertProviderAliasLog = (
    record: Omit<
      RequestLogInsert,
      | "requestId"
      | "startedAtMs"
      | "method"
      | "path"
      | "clientIp"
      | "clientIpSource"
      | "userAgent"
      | "userId"
      | "safetyIdentifier"
      | "promptCacheKey"
      | "isSubagent"
      | "clientModel"
      | "upstreamEndpoint"
      | "stream"
      | "upstreamModel"
    >,
  ): void => {
    if (requestRecorded) {
      logger.warn("provider alias request already recorded", { requestId })
      return
    }
    requestRecorded = true
    const finishedAtMs = Date.now()
    getRequestHistoryStore().insert({
      requestId,
      startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      method,
      path,
      clientIp,
      clientIpSource,
      userAgent,
      userId,
      safetyIdentifier: safetyIdentifier ?? undefined,
      promptCacheKey: promptCacheKey ?? undefined,
      isSubagent,
      clientModel: originalModel,
      upstreamEndpoint: `/providers/${provider}/messages`,
      stream: streamRequested,
      upstreamModel: providerModel,
      ...record,
    })
  }
  const instrumentation: ProviderMessagesInstrumentation = {
    onComplete: (usage: UsageTokens) => {
      insertProviderAliasLog({
        ...normalizeProviderAliasUsage(usage),
        httpStatus: 200,
      })
    },
    onError: (error: ProviderStreamError) => {
      insertProviderAliasLog({
        httpStatus: error.httpStatus,
        errorName: error.errorName,
        errorStatus: error.errorStatus,
        errorMessage: error.errorMessage,
        upstreamErrorMessageRaw: error.upstreamErrorMessageRaw,
      })
    },
  }

  payload.model = providerModel

  try {
    return await handleProviderMessagesForProvider(c, {
      instrumentation,
      payload,
      provider,
    })
  } catch (error) {
    const observableError = await extractErrorObservability(error)
    instrumentation.onError?.(observableError)
    throw error
  }
}

// eslint-disable-next-line max-lines-per-function, complexity
export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const providerConfigResolver = getProviderConfigResolver(c)
  const providerModelAlias = resolveExistingProviderModelAlias(
    anthropicPayload.model,
    providerConfigResolver,
  )
  const providerTargetModelAlias =
    providerModelAlias
    ?? resolveProviderTargetModelAlias(
      anthropicPayload.model,
      providerConfigResolver,
    )
  if (providerTargetModelAlias) {
    return await handleProviderAliasCompletion(c, {
      payload: anthropicPayload,
      provider: providerTargetModelAlias.provider,
      providerModel: providerTargetModelAlias.model,
    })
  }

  await checkRateLimit(state)
  const store = getRequestHistoryStore()
  const requestId = randomUUID()
  const startedAtMs = Date.now()
  const method = c.req.raw.method
  const path = new URL(c.req.url, "http://local").pathname
  const { ip: clientIp, source: clientIpSource } = getClientIpInfo(c)
  const userAgent = c.req.header("user-agent") ?? undefined
  normalizeSystemMessages(anthropicPayload)
  sanitizeIdeTools(anthropicPayload)
  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  const markerInspection = inspectSubagentMarkerFromFirstUser(anthropicPayload)
  const subagentMarker =
    markerInspection.kind === "valid" ? markerInspection.marker : null
  const isSubagentRequest = subagentMarker !== null
  const invalidSubagentMarkerSelectionReason:
    | AccountSelectionReason
    | undefined =
    markerInspection.kind === "invalid" ?
      "subagent_marker_invalid_fallback"
    : undefined
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  const ownershipLookupSessionId =
    markerInspection.kind === "valid" ?
      normalizeStableSessionId(markerInspection.marker.session_id)
    : undefined
  const ownershipWriteSessionId =
    markerInspection.kind === "none" ? sessionId : undefined

  const anthropicBeta = c.req.header("anthropic-beta")
  const compactType = getCompactType(anthropicPayload)
  const isCompact = compactType !== 0
  const originalRequestModel = anthropicPayload.model

  // Fix warmup probe: force small model for Claude Code warmup requests (CLAUDE_CODE_SUBAGENT_MODEL also works).
  if (anthropicBeta && isWarmupProbeRequest(anthropicPayload)) {
    anthropicPayload.model = getSmallModel()
  }

  if (compactType !== 0) {
    logger.debug("Compact request type:", compactType)
  }

  const lastMessageCacheControl = getLastMessageContentCacheControl(
    anthropicPayload.messages.at(-1),
  )

  if (compactType === COMPACT_REQUEST && shouldCompactUseSmallModel()) {
    anthropicPayload.model = getSmallModel()
  }

  if (compactType === 0) {
    stripToolReferenceTurnBoundary(anthropicPayload)

    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    mergeToolResultForClaude(anthropicPayload)
  }

  applyLastMessageCacheControl(anthropicPayload, lastMessageCacheControl)

  const upstreamRequestId = generateRequestIdFromPayload(
    anthropicPayload,
    sessionId,
  )
  logger.debug("Generated request ID:", upstreamRequestId)

  const clientModel = anthropicPayload.model
  anthropicPayload.model = resolveModelAlias(anthropicPayload.model)
  const routingModel = anthropicPayload.model
  const streamRequested = Boolean(anthropicPayload.stream)
  const rawUserId = anthropicPayload.metadata?.user_id
  const userId = typeof rawUserId === "string" ? rawUserId : undefined
  const { safetyIdentifier, sessionId: promptCacheKey } =
    parseUserIdMetadata(userId)
  const normalizedSafetyIdentifier = safetyIdentifier ?? undefined
  const normalizedPromptCacheKey = promptCacheKey ?? undefined
  const openAIPayload = translateToOpenAI(anthropicPayload)
  const fallbackInitiator = resolveEffectiveInitiator(
    getChatInitiator(openAIPayload.messages),
    {
      isCompact,
      isSubagent: isSubagentRequest,
    },
  )

  const blockedResponse = maybeBlockOriginalModelName({
    c,
    store,
    requestId,
    startedAtMs,
    method,
    path,
    streamRequested,
    clientModel,
    clientIp,
    clientIpSource,
    userAgent,
    userId,
    safetyIdentifier: normalizedSafetyIdentifier,
    promptCacheKey: normalizedPromptCacheKey,
    initiator: fallbackInitiator,
    isSubagent: isSubagentRequest,
    selectionReason: invalidSubagentMarkerSelectionReason,
  })
  if (blockedResponse) return blockedResponse

  const endpointModel = findEndpointModel(routingModel)
  const resolvedClientModel = endpointModel?.id ?? routingModel
  const affinityModelId =
    routingModel !== originalRequestModel ?
      (findEndpointModel(originalRequestModel)?.id ?? originalRequestModel)
    : undefined
  const useMessagesApi = isMessagesApiEnabled()

  const candidates: Array<{ modelId: string; endpoint: string }> = []
  if (useMessagesApi) {
    candidates.push({
      modelId: resolvedClientModel,
      endpoint: MESSAGES_ENDPOINT,
    })
  }
  candidates.push(
    {
      modelId: resolvedClientModel,
      endpoint: RESPONSES_ENDPOINT,
    },
    {
      modelId: endpointModel?.id ?? openAIPayload.model,
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
    },
  )

  const headerSessionId = c.req.header("x-session-id") ?? null
  const affinityKey = resolveAffinityKey({
    metadataSessionId: promptCacheKey,
    headerSessionId,
    upstreamRequestId,
  })
  const responsesItemOwnershipKeys =
    extractAnthropicResponsesItemOwnerKeys(anthropicPayload)

  const selection = await accountsManager.selectAccountForRequest(candidates, {
    requestId: affinityKey.requestId,
    affinityModelId,
    ownershipLookupSessionId,
    ownershipWriteSessionId,
    responsesItemOwnershipKeys,
  })
  const selectionReason =
    invalidSubagentMarkerSelectionReason ?? selection.selectionReason
  if (!selection.ok) {
    return handleSelectionFailure({
      c,
      store,
      requestId,
      startedAtMs,
      method,
      path,
      streamRequested,
      clientModel,
      clientIp,
      clientIpSource,
      userAgent,
      userId,
      safetyIdentifier: normalizedSafetyIdentifier,
      promptCacheKey: normalizedPromptCacheKey,
      initiator: fallbackInitiator,
      isSubagent: isSubagentRequest,
      affinityKeyUsed: affinityKey.affinityKeyUsed,
      affinityKeySource: affinityKey.affinityKeySource,
      selectionReason,
      responsesItemOwnerLookupKeys: responsesItemOwnershipKeys,
      selection,
    })
  }
  const { account, reservation, selectedModel, endpoint, costUnits } = selection
  openAIPayload.model = selectedModel.id
  anthropicPayload.model = selectedModel.id
  const premiumRemainingBefore = account.premiumRemaining
  const premiumUnlimitedBefore = account.unlimited
  if (state.manualApprove) {
    await awaitApproval()
  }
  const instr: InstrumentationContext = {
    store,
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
    userId,
    safetyIdentifier: normalizedSafetyIdentifier,
    promptCacheKey: normalizedPromptCacheKey,
    isSubagent: isSubagentRequest,
    clientModel,
    account,
    reservation,
    upstreamEndpoint: endpoint,
    upstreamModel: selectedModel.id,
    costUnits,
    upstreamRequestId,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    confirmAffinity: selection.confirmAffinity,
    confirmOwnership: selection.confirmOwnership,
    affinityHit: selection.affinityHit,
    affinityCacheKey: selection.affinityCacheKey,
    affinityKeyUsed: affinityKey.affinityKeyUsed,
    affinityKeySource: affinityKey.affinityKeySource,
    selectionReason,
    responsesItemOwnerLookupKeys: responsesItemOwnershipKeys,
  }
  if (endpoint === MESSAGES_ENDPOINT) {
    return await handleWithMessagesApi({
      c,
      anthropicPayload,
      anthropicBetaHeader: anthropicBeta ?? undefined,
      subagentMarker,
      sessionId,
      instr,
      selectedModel,
      compactType,
    })
  }
  if (endpoint === RESPONSES_ENDPOINT) {
    return await handleWithResponsesApi({
      c,
      anthropicPayload,
      openAIPayload,
      subagentMarker,
      sessionId,
      selectedModel,
      instr,
      compactType,
    })
  }

  return await handleWithChatCompletions({
    c,
    openAIPayload,
    subagentMarker,
    sessionId,
    selectedModel,
    instr,
    compactType,
  })
}

const handleWithChatCompletions = async (params: {
  c: Context
  openAIPayload: ChatCompletionsPayload
  subagentMarker?: SubagentMarker | null
  sessionId?: string
  selectedModel: Model
  instr: InstrumentationContext
  compactType?: CompactType
}): Promise<Response> => {
  const {
    c,
    openAIPayload,
    subagentMarker,
    sessionId,
    selectedModel,
    instr,
    compactType,
  } = params
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const ctx = toAccountContext(instr.account)
  const initiator = getChatInitiator(openAIPayload.messages)
  const isCompact = compactType !== 0
  const effectiveInitiator = resolveEffectiveInitiator(initiator, {
    isCompact,
    isSubagent: Boolean(subagentMarker),
  })

  instr.initiator = effectiveInitiator

  let response: ChatCompletionsResult

  try {
    response = await createChatCompletions(openAIPayload, ctx, {
      upstreamRequestId: instr.upstreamRequestId,
      initiator: effectiveInitiator,
      subagentMarker,
      sessionId,
      compactType,
      requestId: instr.requestId,
    })
    instr.confirmAffinity?.()
    instr.confirmOwnership?.()
  } catch (error) {
    return await handleChatCompletionsCreateError({
      error,
      instr,
      stream: Boolean(openAIPayload.stream),
    })
  }

  if (isNonStreaming(response)) {
    return handleChatCompletionsNonStreaming({
      c,
      response,
      instr,
    })
  }

  logger.debug("Streaming response from Copilot")

  const fallbackEnabled = isMessageStartInputTokensFallbackEnabled()

  const estimatedInputTokens =
    fallbackEnabled ?
      await estimateInputTokens(openAIPayload, selectedModel, logger)
    : undefined

  const historicalUsage =
    fallbackEnabled && instr.promptCacheKey && instr.safetyIdentifier ?
      instr.store.getLastCompletedUsageBySession({
        promptCacheKey: instr.promptCacheKey,
        safetyIdentifier: instr.safetyIdentifier,
        clientModel: instr.clientModel,
      })
    : null

  return streamSSE(c, (stream) =>
    streamChatCompletionsAndLog({
      stream,
      response,
      instr,
      estimatedInputTokens,
      historicalUsage: historicalUsage ?? undefined,
    }),
  )
}

const handleWithResponsesApi = async (params: {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  openAIPayload: ChatCompletionsPayload
  subagentMarker?: SubagentMarker | null
  sessionId?: string
  selectedModel: Model
  instr: InstrumentationContext
  compactType?: CompactType
}): Promise<Response> => {
  const {
    c,
    anthropicPayload,
    openAIPayload,
    subagentMarker,
    sessionId,
    selectedModel,
    instr,
    compactType,
  } = params
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    {
      modelOverride: selectedModel.id,
      subagentAgentId: subagentMarker?.agent_id,
    },
  )

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(responsesPayload)

  debugJson(logger, "Translated Responses payload:", responsesPayload)

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport =
    getResponsesTransportForModel(selectedModel, { compactType }) ?? "http"
  const isCompact = compactType !== 0
  const effectiveInitiator = resolveEffectiveInitiator(initiator, {
    isCompact,
    isSubagent: Boolean(subagentMarker),
  })
  const ctx = toAccountContext(instr.account)

  instr.initiator = effectiveInitiator

  let response: Awaited<ReturnType<typeof createResponses>>

  try {
    response = await createResponses(
      responsesPayload,
      {
        vision,
        initiator: effectiveInitiator,
        upstreamRequestId: instr.upstreamRequestId,
        subagentMarker,
        sessionId,
        compactType,
        requestId: instr.requestId,
        transport,
      },
      ctx,
    )
    instr.confirmAffinity?.()
    instr.confirmOwnership?.()
  } catch (error) {
    return await handleResponsesCreateError({
      error,
      instr,
      stream: Boolean(responsesPayload.stream),
    })
  }

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")

    const fallbackEnabled = isMessageStartInputTokensFallbackEnabled()

    const estimatedInputTokens =
      fallbackEnabled ?
        await estimateInputTokens(openAIPayload, selectedModel, logger)
      : undefined

    const historicalUsage =
      fallbackEnabled && instr.promptCacheKey && instr.safetyIdentifier ?
        instr.store.getLastCompletedUsageBySession({
          promptCacheKey: instr.promptCacheKey,
          safetyIdentifier: instr.safetyIdentifier,
          clientModel: instr.clientModel,
        })
      : null

    return streamSSE(c, (stream) =>
      streamResponsesAndLog({
        stream,
        response,
        instr,
        estimatedInputTokens,
        historicalUsage: historicalUsage ?? undefined,
      }),
    )
  }

  return handleResponsesNonStreaming({
    c,
    result: response as ResponsesResult,
    instr,
  })
}

type Store = ReturnType<typeof getRequestHistoryStore>

type RequestLogInsert = Parameters<Store["insert"]>[0]

type StreamSseStream = Parameters<Parameters<typeof streamSSE>[1]>[0]

type ChatCompletionsResult = Awaited<ReturnType<typeof createChatCompletions>>

type ChatCompletionsStream = Exclude<
  ChatCompletionsResult,
  ChatCompletionResponse
>

type MessagesResult = Awaited<ReturnType<typeof createMessages>>

function stringifyOwnerKeys(keys?: ReadonlyArray<string>): string | undefined {
  return keys && keys.length > 0 ? JSON.stringify(keys) : undefined
}

function insertRequestLog(
  instr: InstrumentationContext,
  record: Omit<
    RequestLogInsert,
    | "requestId"
    | "startedAtMs"
    | "method"
    | "path"
    | "clientIp"
    | "clientIpSource"
    | "userAgent"
    | "clientModel"
    | "upstreamEndpoint"
    | "accountId"
    | "accountType"
    | "costUnits"
    | "upstreamModel"
    | "premiumRemainingBefore"
    | "premiumUnlimitedBefore"
    | "affinityKeyUsed"
    | "affinityKeySource"
    | "selectionReason"
  >,
): void {
  const {
    store,
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
    clientModel,
    account,
    upstreamEndpoint,
    upstreamModel,
    costUnits,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
  } = instr

  store.insert({
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
    userId: instr.userId,
    safetyIdentifier: instr.safetyIdentifier,
    promptCacheKey: instr.promptCacheKey,
    initiator: instr.initiator,
    isSubagent: instr.isSubagent,
    upstreamRequestId: instr.upstreamRequestId,
    affinityHit: instr.affinityHit,
    affinityCacheKey: instr.affinityCacheKey,
    affinityKeyUsed: instr.affinityKeyUsed,
    affinityKeySource: instr.affinityKeySource,
    selectionReason: instr.selectionReason,
    clientModel,
    upstreamEndpoint,
    accountId: account.id,
    accountType: account.accountType,
    costUnits,
    upstreamModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    ...record,
    responsesItemOwnerLookupKeysJson: stringifyOwnerKeys(
      instr.responsesItemOwnerLookupKeys,
    ),
    responsesItemOwnerRecordedKeysJson: stringifyOwnerKeys(
      instr.responsesItemOwnerRecordedKeys,
    ),
  })
  void flushPendingCapture(requestId)
}

async function finalizeQuotaAndGetPremiumSnapshot(
  instr: InstrumentationContext,
): Promise<{
  premiumRemainingAfter: number | undefined
  premiumUnlimitedAfter: boolean | undefined
  premiumRemainingDiff: number | undefined
}> {
  await accountsManager.finalizeQuota(instr.account, instr.reservation)

  const premiumRemainingAfter = instr.account.premiumRemaining
  const premiumUnlimitedAfter = instr.account.unlimited

  return {
    premiumRemainingAfter,
    premiumUnlimitedAfter,
    premiumRemainingDiff: computeDiff(
      instr.premiumRemainingBefore,
      premiumRemainingAfter,
    ),
  }
}

async function handleChatCompletionsCreateError(params: {
  error: unknown
  instr: InstrumentationContext
  stream: boolean
}): Promise<never> {
  const { error, instr, stream } = params

  const finishedAtMs = Date.now()
  const details = await extractErrorObservability(error)

  if (shouldMarkAccountFailed(details)) {
    accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
  }

  const { premiumRemainingAfter, premiumUnlimitedAfter, premiumRemainingDiff } =
    await finalizeQuotaAndGetPremiumSnapshot(instr)

  insertRequestLog(instr, {
    finishedAtMs,
    durationMs: finishedAtMs - instr.startedAtMs,
    stream,
    premiumRemainingAfter,
    premiumUnlimitedAfter,
    premiumRemainingDiff,
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
    upstreamErrorMessageRaw: details.upstreamErrorMessageRaw,
  })

  throw error
}

async function handleChatCompletionsNonStreaming(params: {
  c: Context
  response: ChatCompletionResponse
  instr: InstrumentationContext
}): Promise<Response> {
  const { c, response, instr } = params

  let httpStatus = 200
  const usage: NormalizedUsage = normalizeChatCompletionsUsage(response.usage)

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  const finishedAtMs = Date.now()

  try {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response),
    )

    const anthropicResponse = translateToAnthropic(response)
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)

    return c.json(anthropicResponse)
  } catch (error) {
    const details = await extractErrorObservability(error)

    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    throw error
  } finally {
    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      stream: false,
      ...usage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus,
      errorName,
      errorStatus,
      errorMessage,
      upstreamErrorMessageRaw,
    })
  }
}

async function streamChatCompletionsAndLog(params: {
  stream: StreamSseStream
  response: ChatCompletionsStream
  instr: InstrumentationContext
  estimatedInputTokens?: number
  historicalUsage?: NormalizedUsage
}): Promise<void> {
  const { stream, response, instr, estimatedInputTokens, historicalUsage } =
    params

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
    thinkingBlockOpen: false,
    estimatedInputTokens,
    historicalInputTokens: historicalUsage?.tokensInput,
    historicalOutputTokens: historicalUsage?.tokensOutput,
    historicalCachedInputTokens: historicalUsage?.tokensCachedInput,
  }

  try {
    for await (const rawEvent of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - instr.startedAtMs
      }

      logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))

      const { data: rawData } = rawEvent as {
        data?: string | Promise<string>
      }
      const data = typeof rawData === "string" ? rawData : await rawData

      if (data === "[DONE]") {
        break
      }

      if (!data) {
        continue
      }

      const chunk = JSON.parse(data) as ChatCompletionChunk
      if (chunk.usage) {
        lastUsage = normalizeChatCompletionsUsage(chunk.usage)
      }

      const events = translateChunkToAnthropicEvents(chunk, streamState)
      for (const event of events) {
        logger.debug("Translated Anthropic event:", JSON.stringify(event))

        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  } catch (error) {
    const details = await extractErrorObservability(error)

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    logger.warn("Streaming error:", error)

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    await writeAnthropicStreamError(stream, getUserVisibleErrorMessage(details))
  } finally {
    const finishedAtMs = Date.now()

    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      ttfbMs,
      stream: true,
      ...lastUsage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus: errorStatus ?? (errorName ? 500 : 200),
      errorName,
      errorStatus,
      errorMessage,
      upstreamErrorMessageRaw,
    })
  }
}

function invalidateAffinityOnOwnershipMismatch(
  ownershipMismatch: boolean,
  instr: Pick<InstrumentationContext, "affinityHit" | "affinityCacheKey">,
): void {
  if (ownershipMismatch && instr.affinityHit && instr.affinityCacheKey) {
    accountsManager.invalidateAffinity(instr.affinityCacheKey)
  }
}

async function handleResponsesCreateError(params: {
  error: unknown
  instr: InstrumentationContext
  stream: boolean
}): Promise<never> {
  const { error, instr, stream } = params

  const finishedAtMs = Date.now()
  const details = await extractErrorObservability(error)

  invalidateAffinityOnOwnershipMismatch(details.ownershipMismatch, instr)

  if (shouldMarkAccountFailed(details)) {
    accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
  }

  const { premiumRemainingAfter, premiumUnlimitedAfter, premiumRemainingDiff } =
    await finalizeQuotaAndGetPremiumSnapshot(instr)

  insertRequestLog(instr, {
    finishedAtMs,
    durationMs: finishedAtMs - instr.startedAtMs,
    stream,
    premiumRemainingAfter,
    premiumUnlimitedAfter,
    premiumRemainingDiff,
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
    upstreamErrorMessageRaw: details.upstreamErrorMessageRaw,
  })

  throw error
}

async function handleResponsesNonStreaming(params: {
  c: Context
  result: ResponsesResult
  instr: InstrumentationContext
}): Promise<Response> {
  const { c, result, instr } = params

  let httpStatus = 200
  let usage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  const finishedAtMs = Date.now()

  try {
    usage = extractResponsesUsageFromResult(result)
    const responseOwnerKeys = extractResponsesResultOwnerKeys(result)
    instr.responsesItemOwnerRecordedKeys = responseOwnerKeys

    logger.debug(
      "Non-streaming Responses result:",
      JSON.stringify(result).slice(-400),
    )

    const anthropicResponse = translateResponsesResultToAnthropic(result)
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)

    const response = c.json(anthropicResponse)
    if (result.status === "completed") {
      accountsManager.recordResponsesItemOwnership(
        responseOwnerKeys,
        instr.account.id,
      )
    }

    return response
  } catch (error) {
    const details = await extractErrorObservability(error)

    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    throw error
  } finally {
    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      stream: false,
      ...usage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus,
      errorName,
      errorStatus,
      errorMessage,
      upstreamErrorMessageRaw,
    })
  }
}

async function ensureResponsesStreamCompleted(params: {
  stream: StreamSseStream
  streamState: ReturnType<typeof createResponsesStreamState>
  setStreamError: (name: string, message: string) => void
}): Promise<void> {
  const { stream, streamState, setStreamError } = params

  if (streamState.messageCompleted) {
    return
  }

  logger.warn("Responses stream ended without completion; sending error event")

  const msg = "Responses stream ended without completion"
  const errorEvent = buildErrorEvent(msg)

  setStreamError("StreamIncomplete", msg)

  await stream.writeSSE({
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  })
}

async function writeAnthropicStreamError(
  stream: StreamSseStream,
  message: string,
): Promise<void> {
  try {
    const errorEvent = buildErrorEvent(message)
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch (streamError) {
    logger.warn("Failed to write Anthropic stream error event:", streamError)
  }
}

function collectResponsesStreamOwnerKeys(
  event: ResponseStreamEvent,
  responseOwnerKeys: Set<string>,
): void {
  for (const key of extractResponsesStreamEventOwnerKeys(event)) {
    responseOwnerKeys.add(key)
  }
}

function createResponsesStreamStateWithUsage(params: {
  estimatedInputTokens?: number
  historicalUsage?: NormalizedUsage
}): ReturnType<typeof createResponsesStreamState> {
  const streamState = createResponsesStreamState()
  streamState.estimatedInputTokens = params.estimatedInputTokens
  streamState.historicalInputTokens = params.historicalUsage?.tokensInput
  streamState.historicalOutputTokens = params.historicalUsage?.tokensOutput
  streamState.historicalCachedInputTokens =
    params.historicalUsage?.tokensCachedInput
  return streamState
}

function recordStreamOwnerKeys(
  streamState: ReturnType<typeof createResponsesStreamState>,
  responseOwnerKeys: Set<string>,
  instr: InstrumentationContext,
): void {
  if (!streamState.messageCompleted) {
    return
  }

  const ownerKeys = [...responseOwnerKeys]
  instr.responsesItemOwnerRecordedKeys = ownerKeys
  if (streamState.responseStatus === "completed") {
    accountsManager.recordResponsesItemOwnership(ownerKeys, instr.account.id)
  }
}

function getResponsesStreamEventError(event: ResponseStreamEvent):
  | {
      errorName: string
      errorStatus: number
      errorMessage: string
      upstreamErrorMessageRaw: string
    }
  | undefined {
  if (event.type === "response.failed") {
    const message =
      event.response.error?.message ?? "Responses stream failed upstream."
    return {
      errorName: "ResponsesStreamFailed",
      errorStatus: 502,
      errorMessage: message,
      upstreamErrorMessageRaw: message,
    }
  }

  if (event.type === "error") {
    const message = event.message || "Responses stream returned an error."
    return {
      errorName: "ResponsesStreamError",
      errorStatus: 502,
      errorMessage: message,
      upstreamErrorMessageRaw: message,
    }
  }

  return undefined
}

async function writeTranslatedAnthropicStreamEvents(
  stream: StreamSseStream,
  events: Array<AnthropicStreamEventData>,
): Promise<void> {
  for (const event of events) {
    const eventData = JSON.stringify(event)
    logger.debug("Translated Anthropic event:", eventData)
    await stream.writeSSE({
      event: event.type,
      data: eventData,
    })
  }
}

async function streamResponsesAndLog(params: {
  stream: StreamSseStream
  response: AsyncIterable<unknown>
  instr: InstrumentationContext
  estimatedInputTokens?: number
  historicalUsage?: NormalizedUsage
}): Promise<void> {
  const { stream, response, instr } = params

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  const streamState = createResponsesStreamStateWithUsage(params)
  const responseOwnerKeys = new Set<string>()

  try {
    for await (const chunk of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - instr.startedAtMs
      }

      const eventName = (chunk as { event?: string }).event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        continue
      }

      const data = (chunk as { data?: string }).data
      if (!data) {
        continue
      }

      logger.debug("Responses raw stream event:", data)

      const parsed = JSON.parse(data) as ResponseStreamEvent
      const streamEventError = getResponsesStreamEventError(parsed)
      if (streamEventError) {
        errorName = streamEventError.errorName
        errorStatus = streamEventError.errorStatus
        errorMessage = streamEventError.errorMessage
        upstreamErrorMessageRaw = streamEventError.upstreamErrorMessageRaw
      }

      collectResponsesStreamOwnerKeys(parsed, responseOwnerKeys)
      const u = extractResponsesUsageFromStreamEvent(parsed)
      if (u.usageJson) {
        lastUsage = u
      }

      const events = translateResponsesStreamEvent(parsed, streamState)
      await writeTranslatedAnthropicStreamEvents(stream, events)

      if (streamState.messageCompleted) {
        logger.debug("Message completed, ending stream")
        break
      }
    }

    await ensureResponsesStreamCompleted({
      stream,
      streamState,
      setStreamError: (name, message) => {
        errorName = name
        errorMessage = message
      },
    })

    recordStreamOwnerKeys(streamState, responseOwnerKeys, instr)
  } catch (error) {
    const details = await extractErrorObservability(error)

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    logger.warn("Streaming error:", error)

    invalidateAffinityOnOwnershipMismatch(details.ownershipMismatch, instr)

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    await writeAnthropicStreamError(stream, getUserVisibleErrorMessage(details))
  } finally {
    const finishedAtMs = Date.now()

    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      ttfbMs,
      stream: true,
      ...lastUsage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus: errorStatus ?? (errorName ? 500 : 200),
      errorName,
      errorStatus,
      errorMessage,
      upstreamErrorMessageRaw,
    })
  }
}

async function handleMessagesCreateError(params: {
  error: unknown
  instr: InstrumentationContext
  stream: boolean
}): Promise<never> {
  const { error, instr, stream } = params

  const finishedAtMs = Date.now()
  const details = await extractErrorObservability(error)

  if (shouldMarkAccountFailed(details)) {
    accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
  }

  const { premiumRemainingAfter, premiumUnlimitedAfter, premiumRemainingDiff } =
    await finalizeQuotaAndGetPremiumSnapshot(instr)

  insertRequestLog(instr, {
    finishedAtMs,
    durationMs: finishedAtMs - instr.startedAtMs,
    stream,
    premiumRemainingAfter,
    premiumUnlimitedAfter,
    premiumRemainingDiff,
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
    upstreamErrorMessageRaw: details.upstreamErrorMessageRaw,
  })

  throw error
}

async function handleMessagesNonStreaming(params: {
  c: Context
  response: AnthropicResponse
  instr: InstrumentationContext
}): Promise<Response> {
  const { c, response, instr } = params

  let httpStatus = 200
  const usage = normalizeMessagesUsage(response.usage)

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  const finishedAtMs = Date.now()

  try {
    logger.debug(
      "Non-streaming Messages result:",
      JSON.stringify(response).slice(-400),
    )
    return c.json(response)
  } catch (error) {
    const details = await extractErrorObservability(error)

    httpStatus = details.httpStatus
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    throw error
  } finally {
    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      stream: false,
      ...usage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus,
      errorName,
      errorStatus,
      errorMessage,
      upstreamErrorMessageRaw,
    })
  }
}

const parseMessagesStreamUsage = (data: string): NormalizedUsage | null => {
  if (!data || data === "[DONE]") return null

  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    if (parsed.type === "error") {
      throw new Error(parsed.error.message)
    }
    if (parsed.type !== "message_delta" || !parsed.usage) {
      return null
    }

    return normalizeMessagesUsage(parsed.usage)
  } catch (error) {
    logger.warn("Failed to parse messages stream event", error)
    throw new Error("Failed to parse messages stream event", { cause: error })
  }
}

async function streamMessagesAndLog(params: {
  stream: StreamSseStream
  response: AsyncIterable<unknown>
  instr: InstrumentationContext
}): Promise<void> {
  const { stream, response, instr } = params

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  try {
    for await (const rawEvent of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - instr.startedAtMs
      }

      const eventNameRaw = (rawEvent as { event?: string }).event
      const eventName =
        typeof eventNameRaw === "string" && eventNameRaw.length > 0 ?
          eventNameRaw
        : "message"
      const data = (rawEvent as { data?: string }).data ?? ""
      logger.debug("Messages raw stream event:", data)

      const usage = parseMessagesStreamUsage(data)
      if (usage) {
        lastUsage = usage
      }

      await stream.writeSSE({
        event: eventName,
        data,
      })
    }
  } catch (error) {
    const details = await extractErrorObservability(error)

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    logger.warn("Streaming error:", error)

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }

    await writeAnthropicStreamError(stream, getUserVisibleErrorMessage(details))
  } finally {
    const finishedAtMs = Date.now()

    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      ttfbMs,
      stream: true,
      ...lastUsage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus: errorStatus ?? (errorName ? 500 : 200),
      errorName,
      errorStatus,
      errorMessage,
      upstreamErrorMessageRaw,
    })
  }
}

const handleWithMessagesApi = async (params: {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  anthropicBetaHeader?: string
  subagentMarker?: SubagentMarker | null
  sessionId?: string
  instr: InstrumentationContext
  selectedModel: Model
  compactType?: CompactType
}): Promise<Response> => {
  const {
    c,
    anthropicPayload,
    anthropicBetaHeader,
    subagentMarker,
    sessionId,
    instr,
    selectedModel,
    compactType,
  } = params

  prepareMessagesApiPayload(anthropicPayload, selectedModel)

  debugJson(logger, "Translated Messages payload:", anthropicPayload)

  const ctx = toAccountContext(instr.account)
  const initiator = getMessagesInitiator(anthropicPayload)
  const isCompact = compactType !== 0
  const effectiveInitiator = resolveEffectiveInitiator(initiator, {
    isCompact,
    isSubagent: Boolean(subagentMarker),
  })

  instr.initiator = effectiveInitiator

  let response: MessagesResult

  try {
    response = await createMessages(anthropicPayload, ctx, {
      anthropicBetaHeader,
      upstreamRequestId: instr.upstreamRequestId,
      initiator: effectiveInitiator,
      subagentMarker,
      sessionId,
      compactType,
      requestId: instr.requestId,
    })
    instr.confirmAffinity?.()
    instr.confirmOwnership?.()
  } catch (error) {
    return await handleMessagesCreateError({
      error,
      instr,
      stream: Boolean(anthropicPayload.stream),
    })
  }

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, (stream) =>
      streamMessagesAndLog({
        stream,
        response,
        instr,
      }),
    )
  }

  return handleMessagesNonStreaming({
    c,
    response,
    instr,
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
