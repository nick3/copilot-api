import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import type { SubagentMarker } from "~/lib/subagent"

import {
  accountsManager,
  type AccountSelectionReason,
} from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import {
  getAliasTargetSet,
  isResponsesApiWebSearchEnabled,
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
import { parseProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  extractResponsesUsageFromResult,
  extractResponsesUsageFromStreamEvent,
  getClientIpInfo,
  getRequestHistoryStore,
  type NormalizedUsage,
} from "~/lib/request-history"
import { state } from "~/lib/state"
import {
  generateRequestIdFromPayload,
  getUUID,
  parseUserIdMetadata,
  resolveAffinityKey,
  type AffinityKeySource,
} from "~/lib/utils"
import { handleProviderResponsesForProvider } from "~/routes/provider/responses/handler"
import { flushPendingCapture } from "~/services/copilot/copilot-fetch"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponsesTransport,
  type ResponseErrorEvent,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
  getResponsesTransportForModel,
  getStreamChunkFields,
  isAsyncIterable,
  removeWebSearchTool,
  sanitizeOversizedInputImages,
  stripInternalChatMetadataPassthrough,
} from "./utils"
import consola from "consola"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

// eslint-disable-next-line max-lines-per-function
export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  debugJson(logger, "Responses request payload:", payload)

  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }
  stripInternalChatMetadataPassthrough(payload)

  const providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderResponsesForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  const subagentMarker = getCodexResponsesSubagentMarker(c)
  if (subagentMarker) {
    debugJson(logger, "Detected Codex subagent headers:", subagentMarker)
  }
  const incomingSessionId =
    subagentMarker ? getIncomingResponsesSessionId(c) : undefined

  await checkRateLimit(state)

  const store = getRequestHistoryStore()
  const request = buildRequestContext(c)

  const clientModel = payload.model

  if (!isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }
  compactInputByLatestCompaction(payload)

  const streamRequested = Boolean(payload.stream)
  const { initiator: inferredInitiator } = getResponsesRequestOptions(payload)
  const initialInitiator = subagentMarker ? "agent" : inferredInitiator
  const userId = (payload.metadata as { user_id?: string } | null | undefined)
    ?.user_id
  const requestBodyPromptCacheKey =
    typeof payload.prompt_cache_key === "string" ?
      payload.prompt_cache_key
    : null
  const { safetyIdentifier, sessionId: metadataSessionId } =
    parseUserIdMetadata(userId)
  const normalizedSafetyIdentifier = safetyIdentifier ?? undefined
  const normalizedPromptCacheKey =
    requestBodyPromptCacheKey ?? metadataSessionId ?? undefined

  request.userId = userId
  request.safetyIdentifier = normalizedSafetyIdentifier
  request.promptCacheKey = normalizedPromptCacheKey
  request.initiator = initialInitiator

  const blockedTargets = getAliasTargetSet()
  if (blockedTargets.has(clientModel.toLowerCase())) {
    recordSelectionFailure(store, {
      request,
      stream: streamRequested,
      clientModel,
      reason: "MODEL_NOT_SUPPORTED",
    })

    return selectionFailureResponse(c, {
      reason: "MODEL_NOT_SUPPORTED",
      message:
        "This model is only available via an alias. Please use the alias model name.",
    })
  }

  const headerSessionId = c.req.header("x-session-id") ?? null
  const upstreamRequestId = generateRequestIdFromPayload(
    { messages: payload.input },
    incomingSessionId ?? normalizedPromptCacheKey,
  )

  const affinityKey = resolveAffinityKey({
    promptCacheKey: requestBodyPromptCacheKey,
    metadataSessionId,
    headerSessionId,
    upstreamRequestId,
  })
  request.affinityKeyUsed = affinityKey.affinityKeyUsed
  request.affinityKeySource = affinityKey.affinityKeySource

  const selection = await accountsManager.selectAccountForRequest(
    [
      {
        modelId: clientModel,
        endpoint: RESPONSES_ENDPOINT,
      },
    ],
    {
      requestId: affinityKey.requestId,
    },
  )

  if (!selection.ok) {
    recordSelectionFailure(store, {
      request,
      stream: streamRequested,
      clientModel,
      reason: selection.reason,
    })

    return selectionFailureResponse(c, {
      reason: selection.reason,
    })
  }

  const { account, selectedModel } = selection

  request.affinityHit = selection.affinityHit
  request.affinityCacheKey = selection.affinityCacheKey
  request.selectionReason = selection.selectionReason

  const upstreamPayload = { ...payload, model: selectedModel.id }
  removeUnsupportedTools(upstreamPayload)

  const sanitizedImageCount = sanitizeOversizedInputImages(
    upstreamPayload,
    selectedModel.capabilities.limits.vision?.max_prompt_image_size,
  )
  if (sanitizedImageCount > 0) {
    logger.warn(
      `Omitted ${sanitizedImageCount} oversized input image(s) before forwarding to Copilot Responses`,
    )
  }

  applyResponsesApiContextManagement(
    upstreamPayload,
    selectedModel.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(upstreamPayload)

  const premiumRemainingBefore = account.premiumRemaining
  const premiumUnlimitedBefore = account.unlimited

  const transport = getResponsesTransportForModel(selectedModel) ?? "http"
  const { vision, initiator: inferredUpstreamInitiator } =
    getResponsesRequestOptions(upstreamPayload)
  const initiator = subagentMarker ? "agent" : inferredUpstreamInitiator
  request.initiator = initiator
  if (state.manualApprove) await awaitApproval()

  const accountCtx = toAccountContext(account)
  const upstreamSessionId = getUUID(
    incomingSessionId
      ?? normalizedPromptCacheKey
      ?? headerSessionId
      ?? upstreamRequestId,
  )
  request.upstreamRequestId = upstreamRequestId
  request.upstreamSessionId = upstreamSessionId

  // Set by the Responses websocket bridge (src/routes/responses/websocket.ts) so
  // the upstream pool can close the originating bridge socket when its GitHub
  // connection is reaped while idle. Absent for plain HTTP callers.
  const bridgeId = c.req.header("x-responses-bridge-id") ?? undefined

  if (streamRequested) {
    return handleStreamingResponses({
      c,
      store,
      request,
      payload: upstreamPayload,
      selection,
      clientModel,
      accountCtx,
      vision,
      initiator,
      subagentMarker,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
      transport,
      bridgeId,
    })
  }

  return handleNonStreamingResponses({
    c,
    store,
    request,
    payload: upstreamPayload,
    selection,
    clientModel,
    accountCtx,
    vision,
    initiator,
    subagentMarker,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    transport,
    bridgeId,
  })
}

type AccountSelection = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>

type AccountSelectionOk = Extract<AccountSelection, { ok: true }>

type AccountSelectionErr = Extract<AccountSelection, { ok: false }>

type RequestContext = {
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
  upstreamRequestId?: string
  upstreamSessionId?: string

  affinityKeyUsed?: string
  affinityKeySource?: AffinityKeySource
  selectionReason?: AccountSelectionReason
  affinityHit?: boolean
  affinityCacheKey?: string
}

type Store = ReturnType<typeof getRequestHistoryStore>

type RequestLogInsert = Parameters<Store["insert"]>[0]

type ObservedErrorState = {
  httpStatus: number
  errorName?: string
  errorStatus?: number
  errorMessage?: string
  upstreamErrorMessageRaw?: string
}

type StreamSseStream = Parameters<Parameters<typeof streamSSE>[1]>[0]

async function observeRequestError(
  accountId: string,
  error: unknown,
  affinity?: { affinityHit?: boolean; affinityCacheKey?: string },
): Promise<ObservedErrorState> {
  const details = await extractErrorObservability(error)

  if (
    details.ownershipMismatch
    && affinity?.affinityHit
    && affinity.affinityCacheKey
  ) {
    accountsManager.invalidateAffinity(affinity.affinityCacheKey)
  }

  if (shouldMarkAccountFailed(details)) {
    accountsManager.markAccountFailed(accountId, "Unauthorized (401)")
  }

  return {
    httpStatus: details.httpStatus,
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
    upstreamErrorMessageRaw: details.upstreamErrorMessageRaw,
  }
}

function buildResponsesStreamError(message: string): ResponseErrorEvent {
  return {
    type: "error",
    code: null,
    message,
    param: null,
    sequence_number: 0,
  }
}

async function writeResponsesStreamError(
  stream: StreamSseStream,
  message: string,
): Promise<void> {
  try {
    const errorEvent = buildResponsesStreamError(message)
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch (streamError) {
    logger.warn("Failed to write Responses stream error event:", streamError)
  }
}

function buildRequestContext(c: Context): RequestContext {
  const requestId = randomUUID()
  const startedAtMs = Date.now()

  const method = c.req.raw.method
  const path = new URL(c.req.url, "http://local").pathname

  const { ip: clientIp, source: clientIpSource } = getClientIpInfo(c)
  const userAgent = c.req.header("user-agent") ?? undefined

  return {
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
  }
}

function insertRequestLog(
  store: Store,
  request: RequestContext,
  record: Omit<
    RequestLogInsert,
    | "requestId"
    | "startedAtMs"
    | "method"
    | "path"
    | "clientIp"
    | "clientIpSource"
    | "userAgent"
  >,
): void {
  store.insert({
    requestId: request.requestId,
    startedAtMs: request.startedAtMs,
    method: request.method,
    path: request.path,
    clientIp: request.clientIp,
    clientIpSource: request.clientIpSource,
    userAgent: request.userAgent,
    userId: request.userId,
    safetyIdentifier: request.safetyIdentifier,
    promptCacheKey: request.promptCacheKey,
    initiator: request.initiator,
    upstreamRequestId: request.upstreamRequestId,
    affinityKeyUsed: request.affinityKeyUsed,
    affinityKeySource: request.affinityKeySource,
    selectionReason: request.selectionReason,
    affinityHit: request.affinityHit,
    affinityCacheKey: request.affinityCacheKey,
    ...record,
  })
  void flushPendingCapture(request.requestId)
}

function recordSelectionFailure(
  store: Store,
  params: {
    request: RequestContext
    stream: boolean
    clientModel: string
    reason: AccountSelectionErr["reason"]
  },
): void {
  const { request, stream, clientModel, reason } = params

  const finishedAtMs = Date.now()

  insertRequestLog(store, request, {
    finishedAtMs,
    durationMs: finishedAtMs - request.startedAtMs,
    upstreamEndpoint: RESPONSES_ENDPOINT,
    stream,
    clientModel,
    httpStatus: reason === "MODEL_NOT_SUPPORTED" ? 400 : 429,
    selectionFailureReason: reason,
  })
}

function selectionFailureResponse(
  c: Context,
  params: {
    reason: AccountSelectionErr["reason"]
    message?: string
  },
) {
  const { reason, message } = params

  if (reason === "MODEL_NOT_SUPPORTED") {
    return c.json(
      {
        error: {
          message:
            message
            ?? "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  return c.json(
    {
      error: {
        message:
          "All accounts have exhausted their quota. Please wait for quota refresh or add additional accounts.",
        type: "rate_limit_error",
      },
    },
    429,
  )
}

function extractUsageFromChunkData(
  data: string | undefined,
): NormalizedUsage | undefined {
  if (!data) return undefined

  try {
    const event = JSON.parse(data) as ResponseStreamEvent
    const usage = extractResponsesUsageFromStreamEvent(event)
    return usage.usageJson ? usage : undefined
  } catch {
    return undefined
  }
}

async function handleStreamingResponses(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ResponsesPayload
  selection: AccountSelectionOk
  clientModel: string
  accountCtx: Parameters<typeof createResponses>[2]
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker: SubagentMarker | null
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  transport: ResponsesTransport
  bridgeId: string | undefined
}): Promise<Response> {
  const {
    c,
    store,
    request,
    payload,
    selection,
    clientModel,
    accountCtx,
    vision,
    initiator,
    subagentMarker,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    transport,
    bridgeId,
  } = params

  let response: Awaited<ReturnType<typeof createResponses>>

  try {
    response = await createResponses(
      payload,
      {
        vision,
        initiator,
        subagentMarker,
        upstreamRequestId: request.upstreamRequestId,
        sessionId: request.upstreamSessionId,
        requestId: request.requestId,
        transport,
        bridgeId,
      },
      accountCtx,
    )
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

  if (isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")

    return streamSSE(c, (stream) =>
      streamResponsesAndLog({
        stream,
        response,
        store,
        request,
        selection,
        clientModel,
        premiumRemainingBefore,
        premiumUnlimitedBefore,
      }),
    )
  }

  return handleNonStreamingUpstreamResult({
    c,
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    result: response,
  })
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

  if (
    details.ownershipMismatch
    && request.affinityHit
    && request.affinityCacheKey
  ) {
    accountsManager.invalidateAffinity(request.affinityCacheKey)
  }

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

async function handleNonStreamingUpstreamResult(params: {
  c: Context
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  result: ResponsesResult
}): Promise<Response> {
  const {
    c,
    store,
    request,
    selection,
    clientModel,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    result,
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  let httpStatus = 200
  const usage: NormalizedUsage = extractResponsesUsageFromResult(result)
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  const finishedAtMs = Date.now()

  try {
    debugJsonTail(logger, "Forwarding native Responses result:", {
      value: result,
      tailLength: 400,
    })
    return c.json(result)
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

async function streamResponsesAndLog(params: {
  stream: StreamSseStream
  response: AsyncIterable<unknown>
  store: Store
  request: RequestContext
  selection: AccountSelectionOk
  clientModel: string
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
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
  } = params

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

  const idTracker = createStreamIdTracker()
  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}
  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined
  let upstreamErrorMessageRaw: string | undefined

  try {
    for await (const chunk of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - request.startedAtMs
      }

      const { id, event, data } = getStreamChunkFields(chunk)
      const processedData = fixStreamIds(data ?? "", event, idTracker)

      const usage = extractUsageFromChunkData(processedData)
      if (usage) {
        lastUsage = usage
      }

      debugJson(logger, "Responses stream chunk:", chunk)

      await stream.writeSSE({
        id,
        event,
        data: processedData,
      })
    }
  } catch (error) {
    const details = await extractErrorObservability(error)
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage
    upstreamErrorMessageRaw = details.upstreamErrorMessageRaw

    logger.warn("Responses streaming error:", error)

    if (
      details.ownershipMismatch
      && request.affinityHit
      && request.affinityCacheKey
    ) {
      accountsManager.invalidateAffinity(request.affinityCacheKey)
    }

    if (shouldMarkAccountFailed(details)) {
      accountsManager.markAccountFailed(account.id, "Unauthorized (401)")
    }

    await writeResponsesStreamError(stream, getUserVisibleErrorMessage(details))
  } finally {
    const finishedAtMs = Date.now()

    await accountsManager.finalizeQuota(account, reservation)

    const premiumRemainingAfter = account.premiumRemaining
    const premiumUnlimitedAfter = account.unlimited

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

async function handleNonStreamingResponses(params: {
  c: Context
  store: Store
  request: RequestContext
  payload: ResponsesPayload
  selection: AccountSelectionOk
  clientModel: string
  accountCtx: Parameters<typeof createResponses>[2]
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker: SubagentMarker | null
  premiumRemainingBefore: number | undefined
  premiumUnlimitedBefore: boolean | undefined
  transport: ResponsesTransport
  bridgeId: string | undefined
}): Promise<Response> {
  const {
    c,
    store,
    request,
    payload,
    selection,
    clientModel,
    accountCtx,
    vision,
    initiator,
    subagentMarker,
    premiumRemainingBefore,
    premiumUnlimitedBefore,
    transport,
    bridgeId,
  } = params
  const { account, reservation, selectedModel, endpoint, costUnits } = selection
  let usage: NormalizedUsage = {}
  let errorState: ObservedErrorState = { httpStatus: 200 }
  let finishedAtMs: number | undefined
  try {
    const response = await createResponses(
      payload,
      {
        vision,
        initiator,
        subagentMarker,
        upstreamRequestId: request.upstreamRequestId,
        sessionId: request.upstreamSessionId,
        requestId: request.requestId,
        transport,
        bridgeId,
      },
      accountCtx,
    )
    if (isAsyncIterable(response)) {
      throw new Error("Upstream returned a stream unexpectedly")
    }
    selection.confirmAffinity?.()
    finishedAtMs = Date.now()
    const result = response
    usage = extractResponsesUsageFromResult(result)
    debugJsonTail(logger, "Forwarding native Responses result:", {
      value: result,
      tailLength: 400,
    })
    return c.json(result)
  } catch (error) {
    finishedAtMs = Date.now()
    errorState = await observeRequestError(account.id, error, {
      affinityHit: request.affinityHit,
      affinityCacheKey: request.affinityCacheKey,
    })
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
      httpStatus: errorState.httpStatus,
      errorName: errorState.errorName,
      errorStatus: errorState.errorStatus,
      errorMessage: errorState.errorMessage,
      upstreamErrorMessageRaw: errorState.upstreamErrorMessageRaw,
    })
  }
}

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type)) {
      dropped.push(type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}

const getTrimmedHeader = (c: Context, name: string): string | undefined => {
  const value = c.req.header(name)?.trim()
  return value ? value : undefined
}

const getIncomingResponsesSessionId = (c: Context): string | undefined =>
  getTrimmedHeader(c, "session-id") ?? getTrimmedHeader(c, "x-session-id")

const codexSubagentHeaderValues = new Set([
  "collab_spawn",
  "compact",
  "memory_consolidation",
  "review",
])

const getCodexResponsesSubagentMarker = (c: Context): SubagentMarker | null => {
  const agentType = getTrimmedHeader(c, "x-openai-subagent")
  if (!agentType || !codexSubagentHeaderValues.has(agentType)) {
    return null
  }

  const threadId = getTrimmedHeader(c, "thread-id")
  const rootSessionId = getIncomingResponsesSessionId(c)
  const parentThreadId = getTrimmedHeader(c, "x-codex-parent-thread-id")
  if (!threadId && !rootSessionId && !parentThreadId) {
    return null
  }

  // At least one of these is non-null (checked above), so the cast is safe.
  const agentId = (threadId ?? parentThreadId ?? rootSessionId) as string

  return {
    agent_id: agentId,
    agent_type: agentType,
    session_id: threadId ?? rootSessionId ?? agentId,
  }
}
