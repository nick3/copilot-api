import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { accountsManager } from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import {
  getAliasTargetSet,
  getProviderConfig,
  resolveModelAlias,
  resolveMappedModel,
} from "~/lib/config"
import {
  computeDiff,
  extractErrorObservability,
  getUserVisibleErrorMessage,
  shouldMarkAccountFailed,
  toAccountContext,
} from "~/lib/handler-utils"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { resolveExistingProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  getRequestHistoryStore,
  normalizeChatCompletionsUsage,
  type NormalizedUsage,
} from "~/lib/request-history"
import { resolveReasoningEffortForTarget } from "~/lib/reasoning-effort"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  createCopilotTokenUsageRecorder,
  mergeCopilotAiuUsage,
  normalizeCopilotAiuUsage,
  normalizeOpenAIUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  generateRequestIdFromPayload,
  getUUID,
  isNullish,
  parseUserIdMetadata,
  resolveAffinityKey,
} from "~/lib/utils"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import {
  createChatCompletions,
  getChatInitiator,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import {
  buildRequestContext,
  CHAT_COMPLETIONS_ENDPOINT,
  GPT_5_4_MODEL_ID,
  insertRequestLog,
  recordSelectionFailure,
  recordUnsupportedChatCompletionsModel,
  selectionFailureResponse,
  type ChatCompletionsHistoryStore,
  type RequestContext,
  unsupportedChatCompletionsModelResponse,
} from "./support"

const logger = createHandlerLogger("chat-completions-handler")

function buildChatCompletionCandidates(clientModel: string) {
  return [
    {
      modelId: clientModel,
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
    },
  ]
}
function isUnsupportedChatCompletionsModel(modelId: string): boolean {
  return resolveModelAlias(modelId).toLowerCase() === GPT_5_4_MODEL_ID
}

function maybeRejectChatCompletionsClientModel(
  c: Context,
  store: Store,
  params: {
    request: RequestContext
    clientModel: string
    streamRequested: boolean
  },
): Response | null {
  const { request, clientModel, streamRequested } = params

  if (isUnsupportedChatCompletionsModel(clientModel)) {
    recordUnsupportedChatCompletionsModel(store, {
      request,
      clientModel,
      stream: streamRequested,
    })
    return unsupportedChatCompletionsModelResponse(c)
  }

  if (getAliasTargetSet().has(clientModel.toLowerCase())) {
    recordSelectionFailure(store, {
      request,
      clientModel,
      stream: streamRequested,
      reason: "MODEL_NOT_SUPPORTED",
    })
    return selectionFailureResponse(c, {
      clientModel,
      reason: "MODEL_NOT_SUPPORTED",
    })
  }

  return null
}

export async function handleCompletion(c: Context) {
  const payload = await c.req.json<ChatCompletionsPayload>()
  const mappedModelResolver =
    (c.get("resolveMappedModel" as never) as
      | typeof resolveMappedModel
      | undefined) ?? resolveMappedModel
  const providerConfigResolver =
    (c.get("providerConfigResolver" as never) as
      | typeof getProviderConfig
      | undefined) ?? getProviderConfig
  payload.model = mappedModelResolver(payload.model)

  const providerModelAlias = resolveExistingProviderModelAlias(
    payload.model,
    providerConfigResolver,
  )
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderChatCompletionsForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  await checkRateLimit(state)
  const store = getRequestHistoryStore()
  const request = buildRequestContext(c)
  const clientModel = payload.model
  const streamRequested = Boolean(payload.stream)
  const initiator = getChatInitiator(payload.messages)
  const normalizedPromptCacheKey = applyChatRequestMetadata(
    request,
    payload,
    initiator,
  )

  const blockedResponse = maybeRejectChatCompletionsClientModel(c, store, {
    request,
    clientModel,
    streamRequested,
  })
  if (blockedResponse) {
    return blockedResponse
  }

  const selectionResult = await selectChatCompletionAccount({
    c,
    store,
    request,
    payload,
    clientModel,
    streamRequested,
    normalizedPromptCacheKey,
  })
  if (selectionResult instanceof Response) {
    return selectionResult
  }

  const { headerSessionId, selection, upstreamRequestId } = selectionResult
  const { account, reservation, selectedModel } = selection
  request.affinityHit = selection.affinityHit
  request.affinityCacheKey = selection.affinityCacheKey
  request.selectionReason = selection.selectionReason

  const premiumRemainingBefore = account.premiumRemaining
  const premiumUnlimitedBefore = account.unlimited

  if (selectedModel.id === GPT_5_4_MODEL_ID) {
    await accountsManager.finalizeQuota(account, reservation)
    recordUnsupportedChatCompletionsModel(store, {
      request,
      clientModel,
      stream: streamRequested,
      upstreamModel: selectedModel.id,
      accountId: account.id,
      accountType: account.accountType,
      costUnits: selection.costUnits,
      premiumRemainingBefore,
      premiumRemainingAfter: account.premiumRemaining,
      premiumUnlimitedBefore,
      premiumUnlimitedAfter: account.unlimited,
    })
    return unsupportedChatCompletionsModelResponse(c)
  }
  const upstreamPayload = { ...payload, model: selectedModel.id }
  const reasoningEffort = resolveReasoningEffortForTarget({
    explicitEffort: payload.reasoning_effort,
    requestModel: clientModel,
    targetModel: selectedModel,
  })
  if (reasoningEffort) {
    upstreamPayload.reasoning_effort = reasoningEffort
  } else {
    delete upstreamPayload.reasoning_effort
  }

  await logTokenCountForRequest({ payload: upstreamPayload, selectedModel })

  if (state.manualApprove) await awaitApproval()

  const payloadWithMaxTokens = applyDefaultMaxTokens(
    upstreamPayload,
    selectedModel,
  )

  const accountCtx = toAccountContext(account)
  const upstreamSessionId = getUUID(
    normalizedPromptCacheKey ?? headerSessionId ?? upstreamRequestId,
  )
  request.upstreamRequestId = upstreamRequestId
  request.upstreamSessionId = upstreamSessionId
  const recordTokenUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: upstreamSessionId,
    model: selectedModel.id,
    sessionId: normalizedPromptCacheKey ?? headerSessionId ?? undefined,
  })

  if (streamRequested) {
    return handleStreamingRequest({
      c,
      store,
      request,
      payload: payloadWithMaxTokens,
      selection,
      accountCtx,
      clientModel,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
      recordTokenUsage,
    })
  }

  return handleNonStreamingRequest({
    c,
    store,
    request,
    payload: payloadWithMaxTokens,
    selection,
    accountCtx,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    recordTokenUsage,
  })
}

type AccountSelection = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>

type AccountSelectionOk = Extract<AccountSelection, { ok: true }>

type Store = ChatCompletionsHistoryStore

type ChatCompletionsResult = Awaited<ReturnType<typeof createChatCompletions>>

type ChatCompletionsStream = Exclude<
  ChatCompletionsResult,
  ChatCompletionResponse
>

type StreamSseStream = Parameters<Parameters<typeof streamSSE>[1]>[0]

function applyChatRequestMetadata(
  request: RequestContext,
  payload: ChatCompletionsPayload,
  initiator: "agent" | "user",
): string | undefined {
  const userId = payload.user ?? undefined
  const { safetyIdentifier, sessionId: promptCacheKey } =
    parseUserIdMetadata(userId)
  const normalizedPromptCacheKey = promptCacheKey ?? undefined

  request.userId = userId
  request.safetyIdentifier = safetyIdentifier ?? undefined
  request.promptCacheKey = normalizedPromptCacheKey
  request.initiator = initiator

  return normalizedPromptCacheKey
}

async function writeChatCompletionsStreamError(
  stream: StreamSseStream,
  message: string,
): Promise<void> {
  try {
    await stream.writeSSE({
      data: JSON.stringify({
        error: {
          message,
          type: "error",
        },
      }),
    })
    await stream.writeSSE({ data: "[DONE]" })
  } catch (streamError) {
    logger.warn(
      "Failed to write chat completions stream error event:",
      streamError,
    )
  }
}

async function selectChatCompletionAccount(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ChatCompletionsPayload
  clientModel: string
  streamRequested: boolean
  normalizedPromptCacheKey: string | undefined
}): Promise<
  | Response
  | {
      headerSessionId: string | null
      selection: AccountSelectionOk
      upstreamRequestId: string
    }
> {
  const {
    c,
    store,
    request,
    payload,
    clientModel,
    streamRequested,
    normalizedPromptCacheKey,
  } = params

  debugJsonTail(logger, "Request payload:", { value: payload, tailLength: 400 })
  const upstreamRequestId = generateRequestIdFromPayload(
    payload,
    normalizedPromptCacheKey,
  )
  const headerSessionId = c.req.header("x-session-id") ?? null
  const affinityKey = resolveAffinityKey({
    metadataSessionId: normalizedPromptCacheKey,
    headerSessionId,
    upstreamRequestId,
  })

  request.affinityKeyUsed = affinityKey.affinityKeyUsed
  request.affinityKeySource = affinityKey.affinityKeySource

  const selection = await accountsManager.selectAccountForRequest(
    buildChatCompletionCandidates(clientModel),
    {
      requestId: affinityKey.requestId,
    },
  )
  if (!selection.ok) {
    recordSelectionFailure(store, {
      request,
      clientModel,
      stream: streamRequested,
      reason: selection.reason,
    })
    return selectionFailureResponse(c, {
      clientModel,
      reason: selection.reason,
    })
  }

  return {
    headerSessionId,
    selection,
    upstreamRequestId,
  }
}

async function logTokenCountForRequest(params: {
  payload: ChatCompletionsPayload
  selectedModel: AccountSelectionOk["selectedModel"]
}) {
  try {
    const tokenCount = await getTokenCount(params.payload, params.selectedModel)
    logger.info("Current token count:", tokenCount)
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
  }
}

function applyDefaultMaxTokens(
  payload: ChatCompletionsPayload,
  selectedModel: AccountSelectionOk["selectedModel"],
): ChatCompletionsPayload {
  if (!isNullish(payload.max_tokens)) {
    return payload
  }

  const updated = {
    ...payload,
    max_tokens: selectedModel.capabilities.limits.max_output_tokens,
  }

  debugJson(logger, "Set max_tokens to:", updated.max_tokens)

  return updated
}

async function handleStreamingRequest(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ChatCompletionsPayload
  selection: AccountSelectionOk
  accountCtx: Parameters<typeof createChatCompletions>[1]
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  recordTokenUsage: (usage: UsageTokens) => void
}): Promise<Response> {
  const {
    c,
    store,
    request,
    payload,
    selection,
    accountCtx,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    recordTokenUsage,
  } = params

  let response: ChatCompletionsResult

  try {
    response = await createChatCompletions(payload, accountCtx, {
      upstreamRequestId: request.upstreamRequestId,
      sessionId: request.upstreamSessionId,
      requestId: request.requestId,
    })
    selection.confirmAffinity?.()
  } catch (error) {
    return handleUpstreamCreateError({
      store,
      request,
      selection,
      clientModel,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
      error,
    })
  }

  // A defensive guard: stream requested, but upstream returned a non-stream response.
  if (isNonStreaming(response)) {
    return handleNonStreamingUpstreamResponse({
      c,
      store,
      request,
      selection,
      clientModel,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
      response,
      recordTokenUsage,
    })
  }

  logger.debug("Streaming response")

  return streamSSE(c, (stream) =>
    streamChatCompletionsAndLog({
      stream,
      response,
      store,
      request,
      selection,
      clientModel,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
      recordTokenUsage,
    }),
  )
}

async function handleUpstreamCreateError(params: {
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  error: unknown
}): Promise<never> {
  const {
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    error,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  const finishedAtMs = Date.now()
  const details = await extractErrorObservability(error)

  if (shouldMarkAccountFailed(details)) {
    accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
  }

  await accountsManager.finalizeQuota(account, reservation)

  const premiumRemainingAfter = account.premiumRemaining
  const premiumUnlimitedAfter = account.unlimited

  insertRequestLog(store, request, {
    finishedAtMs,
    durationMs: finishedAtMs - request.startedAtMs,
    upstreamEndpoint: endpoint,
    stream: true,
    accountId: account.id,
    accountType: account.accountType,
    costUnits,
    clientModel,
    upstreamModel: selectedModel.id,
    premiumRemainingBefore,
    premiumRemainingAfter,
    premiumRemainingDiff: computeDiff(
      premiumRemainingBefore,
      premiumRemainingAfter,
    ),
    premiumUnlimitedBefore,
    premiumUnlimitedAfter,
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
    upstreamErrorMessageRaw: details.upstreamErrorMessageRaw,
  })

  throw error
}

async function handleNonStreamingUpstreamResponse(params: {
  c: Context
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  response: ChatCompletionResponse
  recordTokenUsage: (usage: UsageTokens) => void
}): Promise<Response> {
  const {
    c,
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    response,
    recordTokenUsage,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  let httpStatus = 200
  const usage: NormalizedUsage = normalizeChatCompletionsUsage(response.usage)
  const tokenUsage = mergeCopilotAiuUsage(
    normalizeOpenAIUsage(response.usage),
    response.copilot_usage,
  )
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  const finishedAtMs = Date.now()

  try {
    debugJson(logger, "Non-streaming response:", response)
    recordTokenUsage(tokenUsage)
    return c.json(response)
  } catch (error) {
    const details = await extractErrorObservability(error)
    httpStatus = details.httpStatus
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    throw error
  } finally {
    await accountsManager.finalizeQuota(account, reservation)

    const premiumRemainingAfter = account.premiumRemaining
    const premiumUnlimitedAfter = account.unlimited

    insertRequestLog(store, request, {
      finishedAtMs,
      durationMs: finishedAtMs - request.startedAtMs,
      upstreamEndpoint: endpoint,
      stream: false,
      accountId: account.id,
      accountType: account.accountType,
      costUnits,
      clientModel,
      upstreamModel: selectedModel.id,
      ...usage,
      premiumRemainingBefore,
      premiumRemainingAfter,
      premiumRemainingDiff: computeDiff(
        premiumRemainingBefore,
        premiumRemainingAfter,
      ),
      premiumUnlimitedBefore,
      premiumUnlimitedAfter,
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
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  recordTokenUsage: (usage: UsageTokens) => void
}): Promise<void> {
  const {
    stream,
    response,
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    recordTokenUsage,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}
  let tokenUsage: UsageTokens | undefined
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  try {
    for await (const rawChunk of response) {
      const chunk = rawChunk as SSEMessage

      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - request.startedAtMs
      }

      const usage = await extractUsageFromChunk(chunk)
      if (usage?.requestHistoryUsage) {
        lastUsage = usage.requestHistoryUsage
        tokenUsage = usage.tokenUsage
      } else if (usage?.tokenUsage) {
        tokenUsage = {
          ...(tokenUsage ?? {}),
          ...usage.tokenUsage,
        }
      }

      debugJson(logger, "Streaming chunk:", chunk)
      await stream.writeSSE(chunk)
    }
  } catch (error) {
    const details = await extractErrorObservability(error)
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    logger.warn("Streaming error:", error)

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
    }

    await writeChatCompletionsStreamError(
      stream,
      getUserVisibleErrorMessage(details),
    )
  } finally {
    const finishedAtMs = Date.now()

    await accountsManager.finalizeQuota(account, reservation)

    const premiumRemainingAfter = account.premiumRemaining
    const premiumUnlimitedAfter = account.unlimited

    if (tokenUsage) {
      recordTokenUsage(tokenUsage)
    }

    insertRequestLog(store, request, {
      finishedAtMs,
      durationMs: finishedAtMs - request.startedAtMs,
      ttfbMs,
      upstreamEndpoint: endpoint,
      stream: true,
      accountId: account.id,
      accountType: account.accountType,
      costUnits,
      clientModel,
      upstreamModel: selectedModel.id,
      ...lastUsage,
      premiumRemainingBefore,
      premiumRemainingAfter,
      premiumRemainingDiff: computeDiff(
        premiumRemainingBefore,
        premiumRemainingAfter,
      ),
      premiumUnlimitedBefore,
      premiumUnlimitedAfter,
      httpStatus: errorStatus ?? (errorName ? 500 : 200),
      errorName,
      errorStatus,
      errorMessage,
      upstreamErrorMessageRaw,
    })
  }
}

interface ParsedChatCompletionsChunkUsage {
  requestHistoryUsage?: NormalizedUsage
  tokenUsage?: UsageTokens
}

async function extractUsageFromChunk(
  chunk: SSEMessage,
): Promise<ParsedChatCompletionsChunkUsage | undefined> {
  let data: string | undefined

  try {
    data = typeof chunk.data === "string" ? chunk.data : await chunk.data
  } catch (error) {
    logger.warn("Failed to read chat completions usage chunk:", error)
    return undefined
  }

  if (!data || data === "[DONE]") {
    return undefined
  }

  try {
    const parsed = JSON.parse(data) as ChatCompletionChunk
    if (!parsed.usage && !parsed.copilot_usage) return undefined
    if (!parsed.usage) {
      return {
        tokenUsage: normalizeCopilotAiuUsage(parsed.copilot_usage),
      }
    }

    return {
      requestHistoryUsage: normalizeChatCompletionsUsage(parsed.usage),
      tokenUsage: mergeCopilotAiuUsage(
        normalizeOpenAIUsage(parsed.usage),
        parsed.copilot_usage,
      ),
    }
  } catch (error) {
    logger.warn("Failed to parse chat completions usage chunk:", {
      error,
      data,
    })
    return undefined
  }
}

async function handleNonStreamingRequest(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ChatCompletionsPayload
  selection: AccountSelectionOk
  accountCtx: Parameters<typeof createChatCompletions>[1]
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  recordTokenUsage: (usage: UsageTokens) => void
}): Promise<Response> {
  const {
    c,
    store,
    request,
    payload,
    selection,
    accountCtx,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    recordTokenUsage,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  let httpStatus = 200
  let usage: NormalizedUsage = {}
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined
  let finishedAtMs: number | undefined

  try {
    const response = await createChatCompletions(payload, accountCtx, {
      upstreamRequestId: request.upstreamRequestId,
      sessionId: request.upstreamSessionId,
      requestId: request.requestId,
    })
    if (!isNonStreaming(response)) {
      throw new Error("Upstream returned a stream unexpectedly")
    }
    selection.confirmAffinity?.()
    finishedAtMs = Date.now()
    usage = normalizeChatCompletionsUsage(response.usage)
    recordTokenUsage(
      mergeCopilotAiuUsage(
        normalizeOpenAIUsage(response.usage),
        response.copilot_usage,
      ),
    )

    debugJson(logger, "Non-streaming response:", response)
    return c.json(response)
  } catch (error) {
    finishedAtMs = Date.now()

    const details = await extractErrorObservability(error)
    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
    }

    throw error
  } finally {
    const finishedAtMsFinal = finishedAtMs ?? Date.now()

    await accountsManager.finalizeQuota(account, reservation)

    const premiumRemainingAfter = account.premiumRemaining
    const premiumUnlimitedAfter = account.unlimited

    insertRequestLog(store, request, {
      finishedAtMs: finishedAtMsFinal,
      durationMs: finishedAtMsFinal - request.startedAtMs,
      upstreamEndpoint: endpoint,
      stream: false,
      accountId: account.id,
      accountType: account.accountType,
      costUnits,
      clientModel,
      upstreamModel: selectedModel.id,
      ...usage,
      premiumRemainingBefore,
      premiumRemainingAfter,
      premiumRemainingDiff: computeDiff(
        premiumRemainingBefore,
        premiumRemainingAfter,
      ),
      premiumUnlimitedBefore,
      premiumUnlimitedAfter,
      httpStatus,
      errorName,
      errorStatus,
      errorMessage,
      upstreamErrorMessageRaw,
    })
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
