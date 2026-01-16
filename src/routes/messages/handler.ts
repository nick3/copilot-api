import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import type { AccountRuntime } from "~/lib/types/account"

import { accountsManager } from "~/lib/accounts-manager"
import { awaitApproval } from "~/lib/approval"
import { getSmallModel } from "~/lib/config"
import {
  computeDiff,
  extractErrorDetails,
  toAccountContext,
} from "~/lib/handler-utils"
import {
  createHandlerLogger,
  formatStreamLog,
  getPremiumInfo,
} from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  extractResponsesUsageFromResult,
  getClientIpInfo,
  getRequestHistoryStore,
  normalizeChatCompletionsUsage,
  type NormalizedUsage,
} from "~/lib/request-history"
import { state } from "~/lib/state"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { mergeToolResultForClaude } from "~/routes/messages/tool-result-merge"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { streamChatCompletionsAndLog, streamResponsesAndLog } from "./streaming"

const logger = createHandlerLogger("messages-handler")

const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
const RESPONSES_ENDPOINT = "/responses"

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

  clientModel: string

  account: AccountRuntime
  reservation: AccountSelectionOk["reservation"]
  upstreamModel: string
  upstreamEndpoint: string
  costUnits: number

  premiumRemainingBefore?: number
  premiumUnlimitedBefore?: boolean
}

const isWarmupProbeRequest = (payload: AnthropicMessagesPayload): boolean => {
  const lastMsg = payload.messages.at(-1)
  if (!lastMsg || lastMsg.role !== "user" || !Array.isArray(lastMsg.content)) {
    return false
  }

  const lastBlock = lastMsg.content.at(-1)
  if (!lastBlock || lastBlock.type !== "text") {
    return false
  }

  const text = lastBlock.text.trim().toLowerCase()
  return text === "warmup" && lastBlock.cache_control?.type === "ephemeral"
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const store = getRequestHistoryStore()

  const requestId = randomUUID()
  const startedAtMs = Date.now()

  const method = c.req.raw.method
  const path = new URL(c.req.url, "http://local").pathname

  const { ip: clientIp, source: clientIpSource } = getClientIpInfo(c)
  const userAgent = c.req.header("user-agent") ?? undefined

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model for warmup probe requests
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  if (anthropicBeta && isWarmupProbeRequest(anthropicPayload)) {
    anthropicPayload.model = getSmallModel()
  }

  const streamRequested = Boolean(anthropicPayload.stream)

  // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
  // (caused by skill invocations, edit hooks, plan or to do reminders)
  // e.g. {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_xxx","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
  mergeToolResultForClaude(anthropicBeta, anthropicPayload)

  const openAIPayload = translateToOpenAI(anthropicPayload)

  const selection = await accountsManager.selectAccountForRequest([
    {
      modelId: anthropicPayload.model,
      endpoint: RESPONSES_ENDPOINT,
    },
    {
      modelId: openAIPayload.model,
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
    },
  ])

  if (!selection.ok) {
    const finishedAtMs = Date.now()

    store.insert({
      requestId,
      startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      method,
      path,
      stream: streamRequested,
      clientModel: anthropicPayload.model,
      clientIp,
      clientIpSource,
      userAgent,
      httpStatus: selection.reason === "MODEL_NOT_SUPPORTED" ? 400 : 429,
      selectionFailureReason: selection.reason,
    })

    if (selection.reason === "MODEL_NOT_SUPPORTED") {
      return c.json(
        {
          error: {
            message: `Model "${anthropicPayload.model}" is not available for any configured account.`,
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

  const { account, reservation, selectedModel, endpoint, costUnits } = selection

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

    clientModel: anthropicPayload.model,

    account,
    reservation,
    upstreamEndpoint: endpoint,
    upstreamModel: selectedModel.id,
    costUnits,

    premiumRemainingBefore,
    premiumUnlimitedBefore,
  }

  if (endpoint === RESPONSES_ENDPOINT) {
    return await handleWithResponsesApi(c, anthropicPayload, instr)
  }

  return await handleWithChatCompletions(c, openAIPayload, instr)
}

const handleWithChatCompletions = async (
  c: Context,
  openAIPayload: ChatCompletionsPayload,
  instr: InstrumentationContext,
): Promise<Response> => {
  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const ctx = toAccountContext(instr.account)

  let response: ChatCompletionsResult

  try {
    response = await createChatCompletions(openAIPayload, ctx)
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
      model: openAIPayload.model,
    })
  }

  logger.debug("Streaming response from Copilot")

  return streamSSE(c, (stream) =>
    streamChatCompletionsAndLog({
      stream,
      response,
      instr,
      model: openAIPayload.model,
      logger,
      insertRequestLog,
      finalizeQuotaAndGetPremiumSnapshot,
    }),
  )
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  instr: InstrumentationContext,
): Promise<Response> => {
  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const ctx = toAccountContext(instr.account)

  let response: Awaited<ReturnType<typeof createResponses>>

  try {
    response = await createResponses(
      responsesPayload,
      {
        vision,
        initiator,
      },
      ctx,
    )
  } catch (error) {
    return await handleResponsesCreateError({
      error,
      instr,
      stream: Boolean(responsesPayload.stream),
    })
  }

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")

    return streamSSE(c, (stream) =>
      streamResponsesAndLog({
        stream,
        response,
        instr,
        model: responsesPayload.model,
        logger,
        insertRequestLog,
        finalizeQuotaAndGetPremiumSnapshot,
      }),
    )
  }

  return handleResponsesNonStreaming({
    c,
    result: response as ResponsesResult,
    instr,
    model: responsesPayload.model,
  })
}

type Store = ReturnType<typeof getRequestHistoryStore>

type RequestLogInsert = Parameters<Store["insert"]>[0]

type ChatCompletionsResult = Awaited<ReturnType<typeof createChatCompletions>>

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

  try {
    store.insert({
      requestId,
      startedAtMs,
      method,
      path,
      clientIp,
      clientIpSource,
      userAgent,
      clientModel,
      upstreamEndpoint,
      accountId: account.id,
      accountType: account.accountType,
      costUnits,
      upstreamModel,
      premiumRemainingBefore,
      premiumUnlimitedBefore,
      ...record,
    })
  } catch (error) {
    logger.warn("Failed to write request log:", error)
  }
}

async function finalizeQuotaAndGetPremiumSnapshot(
  instr: InstrumentationContext,
): Promise<{
  premiumRemainingAfter: number | undefined
  premiumUnlimitedAfter: boolean | undefined
  premiumRemainingDiff: number | undefined
}> {
  try {
    await accountsManager.finalizeQuota(instr.account, instr.reservation)
  } catch (error) {
    logger.warn("Failed to finalize quota:", error)
  }

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
  const details = extractErrorDetails(error)

  if (details.unauthorized) {
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
  })

  throw error
}

async function handleChatCompletionsNonStreaming(params: {
  c: Context
  response: ChatCompletionResponse
  instr: InstrumentationContext
  model: string
}): Promise<Response> {
  const { c, response, instr, model } = params

  let httpStatus = 200
  const usage: NormalizedUsage = normalizeChatCompletionsUsage(response.usage)

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const finishedAtMs = Date.now()

  try {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response),
    )

    const anthropicResponse = translateToAnthropic(response)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )

    const premium = await getPremiumInfo(instr.account)
    process.stdout.write(
      `${formatStreamLog({
        model,
        chunks: 0,
        done: true,
        premium,
      })}\n`,
    )
    return c.json(anthropicResponse)
  } catch (error) {
    const details = extractErrorDetails(error)

    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    if (details.unauthorized) {
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
    })
  }
}

async function handleResponsesCreateError(params: {
  error: unknown
  instr: InstrumentationContext
  stream: boolean
}): Promise<never> {
  const { error, instr, stream } = params

  const finishedAtMs = Date.now()
  const details = extractErrorDetails(error)

  if (details.unauthorized) {
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
  })

  throw error
}

async function handleResponsesNonStreaming(params: {
  c: Context
  result: ResponsesResult
  instr: InstrumentationContext
  model: string
}): Promise<Response> {
  const { c, result, instr, model } = params

  let httpStatus = 200
  let usage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const finishedAtMs = Date.now()

  try {
    usage = extractResponsesUsageFromResult(result)

    logger.debug(
      "Non-streaming Responses result:",
      JSON.stringify(result).slice(-400),
    )

    const anthropicResponse = translateResponsesResultToAnthropic(result)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )

    const premium = await getPremiumInfo(instr.account)
    process.stdout.write(
      `${formatStreamLog({
        model,
        chunks: 0,
        done: true,
        premium,
      })}\n`,
    )
    return c.json(anthropicResponse)
  } catch (error) {
    const details = extractErrorDetails(error)

    httpStatus = details.httpStatus

    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    if (details.unauthorized) {
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
    })
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
