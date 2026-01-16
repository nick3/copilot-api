import type { ConsolaInstance } from "consola"

import { streamSSE } from "hono/streaming"

import type { AnthropicStreamState } from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type { ResponseStreamEvent } from "~/services/copilot/create-responses"

import { accountsManager } from "~/lib/accounts-manager"
import { extractErrorDetails } from "~/lib/handler-utils"
import { formatStreamLog, getPremiumInfo } from "~/lib/logger"
import {
  extractResponsesUsageFromStreamEvent,
  normalizeChatCompletionsUsage,
  type NormalizedUsage,
} from "~/lib/request-history"
import { setupPingInterval } from "~/lib/utils"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { translateChunkToAnthropicEvents } from "~/routes/messages/stream-translation"

type StreamSseStream = Parameters<Parameters<typeof streamSSE>[1]>[0]

type ChatCompletionsResult = Awaited<
  ReturnType<
    typeof import("~/services/copilot/create-chat-completions").createChatCompletions
  >
>

type ChatCompletionsStream = Exclude<
  ChatCompletionsResult,
  ChatCompletionResponse
>

type AccountSelection = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>

type AccountSelectionOk = Extract<AccountSelection, { ok: true }>

export type InstrumentationContext = {
  store: ReturnType<
    typeof import("~/lib/request-history").getRequestHistoryStore
  >
  requestId: string
  startedAtMs: number
  method: string
  path: string
  clientIp?: string
  clientIpSource?: string
  userAgent?: string
  clientModel: string
  account: import("~/lib/types/account").AccountRuntime
  reservation: AccountSelectionOk["reservation"]
  upstreamModel: string
  upstreamEndpoint: string
  costUnits: number
  premiumRemainingBefore?: number
  premiumUnlimitedBefore?: boolean
}

export type InsertRequestLog = (
  instr: InstrumentationContext,
  record: object,
) => void

export type FinalizeQuotaAndGetPremiumSnapshot = (
  instr: InstrumentationContext,
) => Promise<{
  premiumRemainingAfter: number | undefined
  premiumUnlimitedAfter: boolean | undefined
  premiumRemainingDiff: number | undefined
}>

const writeStreamProgress = (model: string, chunkCount: number) =>
  process.stdout.write(
    formatStreamLog({ model, chunks: chunkCount, done: false }),
  )

const sendStreamErrorEvent = async (
  stream: StreamSseStream,
  message: string,
  logger: ConsolaInstance,
) => {
  try {
    const errorEvent = buildErrorEvent(message)
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch (error) {
    logger.warn("Failed to send streaming error event:", error)
  }
}

const getStreamErrorDetails = (error: unknown) => {
  const details = extractErrorDetails(error)
  return {
    errorName: details.errorName,
    errorStatus: details.errorStatus,
    errorMessage: details.errorMessage,
    unauthorized: details.unauthorized,
  }
}

const getFinalStreamError = (params: {
  pingFailed: boolean
  streamCompleted: boolean
  errorName: string | undefined
  errorMessage: string | undefined
}) => {
  const { pingFailed, streamCompleted, errorName, errorMessage } = params
  if (pingFailed && !errorName && !streamCompleted) {
    return { errorName: "PingFailed", errorMessage: "SSE ping failed" }
  }
  return { errorName, errorMessage }
}

// eslint-disable-next-line max-lines-per-function
export async function streamChatCompletionsAndLog(params: {
  stream: StreamSseStream
  response: ChatCompletionsStream
  instr: InstrumentationContext
  model: string
  logger: ConsolaInstance
  insertRequestLog: InsertRequestLog
  finalizeQuotaAndGetPremiumSnapshot: FinalizeQuotaAndGetPremiumSnapshot
}): Promise<void> {
  const {
    stream,
    response,
    instr,
    model,
    logger,
    insertRequestLog,
    finalizeQuotaAndGetPremiumSnapshot,
  } = params

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
    thinkingBlockOpen: false,
  }

  const pingFailed = { value: false }
  let streamCompleted = false
  const pingInterval = setupPingInterval(stream, 3000, (error) => {
    pingFailed.value = true
    logger.warn("SSE ping failed:", error)
  })
  let chunkCount = 0

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

      if (data === "[DONE]") break
      if (!data) continue

      chunkCount += 1
      writeStreamProgress(model, chunkCount)

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

    streamCompleted = true
  } catch (error) {
    const details = getStreamErrorDetails(error)
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    logger.warn("Streaming error:", error)
    await sendStreamErrorEvent(stream, details.errorMessage, logger)

    if (details.unauthorized) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }
  } finally {
    clearInterval(pingInterval)
    const finishedAtMs = Date.now()

    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    const finalError = getFinalStreamError({
      pingFailed: pingFailed.value,
      streamCompleted,
      errorName,
      errorMessage,
    })

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      ttfbMs,
      stream: true,
      ...lastUsage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus: errorStatus ?? (finalError.errorName ? 500 : 200),
      errorName: finalError.errorName,
      errorStatus,
      errorMessage: finalError.errorMessage,
    })

    const premium = await getPremiumInfo(instr.account)
    process.stdout.write(
      `${formatStreamLog({
        model,
        chunks: chunkCount,
        done: !finalError.errorName,
        premium,
      })}\n`,
    )
  }
}

const ensureResponsesStreamCompleted = async (params: {
  stream: StreamSseStream
  streamState: ReturnType<typeof createResponsesStreamState>
  setStreamError: (name: string, message: string) => void
}): Promise<void> => {
  const { stream, streamState, setStreamError } = params

  if (streamState.messageCompleted) return

  const msg = "Responses stream ended without completion"
  const errorEvent = buildErrorEvent(msg)

  setStreamError("StreamIncomplete", msg)

  await stream.writeSSE({
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  })
}

// eslint-disable-next-line max-lines-per-function
export async function streamResponsesAndLog(params: {
  stream: StreamSseStream
  response: AsyncIterable<unknown>
  instr: InstrumentationContext
  model: string
  logger: ConsolaInstance
  insertRequestLog: InsertRequestLog
  finalizeQuotaAndGetPremiumSnapshot: FinalizeQuotaAndGetPremiumSnapshot
}): Promise<void> {
  const {
    stream,
    response,
    instr,
    model,
    logger,
    insertRequestLog,
    finalizeQuotaAndGetPremiumSnapshot,
  } = params

  let ttfbMs: number | undefined
  let lastUsage: NormalizedUsage = {}

  let errorName: string | undefined
  let errorStatus: number | undefined
  let errorMessage: string | undefined

  const streamState = createResponsesStreamState()

  const pingFailed = { value: false }
  let streamCompleted = false
  const pingInterval = setupPingInterval(stream, 3000, (error) => {
    pingFailed.value = true
    logger.warn("SSE ping failed:", error)
  })
  let chunkCount = 0

  try {
    for await (const chunk of response) {
      if (ttfbMs === undefined) {
        ttfbMs = Date.now() - instr.startedAtMs
      }

      const eventName = (chunk as { event?: string }).event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: "" })
        continue
      }

      const data = (chunk as { data?: string }).data
      if (!data) continue

      chunkCount += 1
      writeStreamProgress(model, chunkCount)

      logger.debug("Responses raw stream event:", data)

      const parsed = JSON.parse(data) as ResponseStreamEvent
      const usage = extractResponsesUsageFromStreamEvent(parsed)
      if (usage.usageJson) {
        lastUsage = usage
      }

      const events = translateResponsesStreamEvent(parsed, streamState)
      for (const event of events) {
        const eventData = JSON.stringify(event)
        logger.debug("Translated Anthropic event:", eventData)
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }

      if (streamState.messageCompleted) break
    }

    await ensureResponsesStreamCompleted({
      stream,
      streamState,
      setStreamError: (name, message) => {
        errorName = name
        errorMessage = message
      },
    })

    streamCompleted = streamState.messageCompleted && !errorName
  } catch (error) {
    const details = getStreamErrorDetails(error)
    errorName = details.errorName
    errorStatus = details.errorStatus
    errorMessage = details.errorMessage

    logger.warn("Streaming error:", error)
    await sendStreamErrorEvent(stream, details.errorMessage, logger)

    if (details.unauthorized) {
      accountsManager.markAccountFailed(instr.account.id, "Unauthorized (401)")
    }
  } finally {
    clearInterval(pingInterval)
    const finishedAtMs = Date.now()

    const {
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
    } = await finalizeQuotaAndGetPremiumSnapshot(instr)

    const finalError = getFinalStreamError({
      pingFailed: pingFailed.value,
      streamCompleted,
      errorName,
      errorMessage,
    })

    insertRequestLog(instr, {
      finishedAtMs,
      durationMs: finishedAtMs - instr.startedAtMs,
      ttfbMs,
      stream: true,
      ...lastUsage,
      premiumRemainingAfter,
      premiumUnlimitedAfter,
      premiumRemainingDiff,
      httpStatus: errorStatus ?? (finalError.errorName ? 500 : 200),
      errorName: finalError.errorName,
      errorStatus,
      errorMessage: finalError.errorMessage,
    })

    const premium = await getPremiumInfo(instr.account)
    process.stdout.write(
      `${formatStreamLog({
        model,
        chunks: chunkCount,
        done: !finalError.errorName,
        premium,
      })}\n`,
    )
  }
}
