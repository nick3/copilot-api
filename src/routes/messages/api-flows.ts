import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import { debugJson, debugJsonTail, debugLazy } from "~/lib/logger"
import { writeSSEIfConnected } from "~/lib/sse"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  normalizeChatCompletionsUsage,
  normalizeMessagesUsage,
  normalizeResponsesUsage,
  type NormalizedUsage,
} from "~/lib/request-history"
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
import {
  createChatCompletions as createCopilotChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"
import { createMessages as createCopilotMessages } from "~/services/copilot/create-messages"
import {
  createResponses as createCopilotResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

const COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT = 1
const COPILOT_CONTEXT_CACHE_CONTROL = {
  type: "ephemeral",
} as const

export const messagesApiFlowDependencies = {
  createChatCompletions: createCopilotChatCompletions,
  createMessages: createCopilotMessages,
  createResponses: createCopilotResponses,
}

export interface FlowBaseOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
}

interface ResponsesFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

interface MessagesFlowOptions extends FlowBaseOptions {
  anthropicBetaHeader?: string
  selectedModel?: Model
}

interface ChatCompletionsFlowOptions extends FlowBaseOptions {
  createChatCompletionsImpl?: typeof createCopilotChatCompletions
  selectedModel?: Model
}

export const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ChatCompletionsFlowOptions,
) => {
  const {
    logger,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
    selectedModel,
    createChatCompletionsImpl = messagesApiFlowDependencies.createChatCompletions,
  } = options
  const openAIPayload = translateToOpenAI(anthropicPayload, {
    validateReasoningEffort: true,
    reasoningEffortSupport:
      selectedModel?.capabilities.supports.reasoning_effort,
  })
  prepareCopilotChatCompletionsPayload(openAIPayload)
  const recordUsage = createNoopUsageRecorder()
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const response = await createChatCompletionsImpl(openAIPayload, undefined, {
    clientSignal: c.req?.raw?.signal,
    subagentMarker,
    upstreamRequestId: requestId,
    sessionId,
    compactType,
    requestId,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response from Copilot:", response)
    recordUsage(normalizeChatCompletionsUsage(response.usage))
    const anthropicResponse = translateToAnthropic(response)
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    let usage: NormalizedUsage = {}
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    try {
      for await (const rawEvent of response) {
        debugJson(logger, "Copilot raw stream event:", rawEvent)
        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        if (chunk.usage || chunk.copilot_usage) {
          usage = {
            ...normalizeChatCompletionsUsage(chunk.usage),
          }
        }
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await writeSSEIfConnected(stream, {
            event: event.type,
            data: eventData,
          })
        }
      }
    } catch (error) {
      logger.warn("Chat completions stream interrupted:", error)
    }

    for (const event of flushPendingAnthropicStreamEvents(streamState)) {
      const eventData = JSON.stringify(event)
      debugLazy(logger, () => ["Translated Anthropic event:", eventData])
      await writeSSEIfConnected(stream, {
        event: event.type,
        data: eventData,
      })
    }

    if (!streamState.messageCompleted) {
      logger.warn(
        "Chat completions stream ended without completion; sending error event",
      )
      const errorEvent = translateErrorToAnthropicErrorEvent()
      await writeSSEIfConnected(stream, {
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }

    recordUsage(usage)
  })
}

export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const { logger, selectedModel, ...requestOptions } = options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  const recordUsage = createNoopUsageRecorder()

  const shouldCompactInput = applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
    {
      source: "messages",
    },
  )

  if (shouldCompactInput) {
    compactInputByLatestCompaction(responsesPayload)
  }

  debugJson(logger, "Translated Responses payload:", responsesPayload)

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport =
    getResponsesTransportForModel(selectedModel, {
      compactType: requestOptions.compactType,
    }) ?? "http"
  const response = await messagesApiFlowDependencies.createResponses(
    responsesPayload,
    {
      ...requestOptions,
      vision,
      initiator,
      clientSignal: c.req?.raw?.signal,
      transport,
      subagentMarker: requestOptions.subagentMarker,
      upstreamRequestId: requestOptions.requestId,
      sessionId: requestOptions.sessionId,
      compactType: requestOptions.compactType,
      requestId: requestOptions.requestId,
    },
  )

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState({
        toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
      })
      let usage: NormalizedUsage = {}

      for await (const chunk of response) {
        const eventName = chunk.event
        if (eventName === "ping") {
          await writeSSEIfConnected(stream, {
            event: "ping",
            data: '{"type":"ping"}',
          })
          continue
        }

        const data = chunk.data
        if (!data) {
          continue
        }

        debugLazy(logger, () => ["Responses raw stream event:", data])

        const responseEvent = JSON.parse(data) as ResponseStreamEvent
        if (
          responseEvent.type === "response.completed"
          || responseEvent.type === "response.failed"
          || responseEvent.type === "response.incomplete"
        ) {
          usage = normalizeResponsesUsage(responseEvent.response.usage)
        }

        const events = translateResponsesStreamEvent(responseEvent, streamState)
        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await writeSSEIfConnected(stream, {
            event: event.type,
            data: eventData,
          })
        }

        if (streamState.messageCompleted) {
          logger.debug("Message completed, ending stream")
          break
        }
      }

      if (!streamState.messageCompleted) {
        logger.warn(
          "Responses stream ended without completion; sending error event",
        )
        const errorEvent = buildErrorEvent(
          "Responses stream ended without completion, retry your request.",
        )
        await writeSSEIfConnected(stream, {
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Non-streaming Responses result:", {
    value: response,
    tailLength: 400,
  })
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
    {
      toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
    },
  )
  recordUsage(normalizeResponsesUsage((response as ResponsesResult).usage))
  debugJson(logger, "Translated Anthropic response:", anthropicResponse)
  return c.json(anthropicResponse)
}

export const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: MessagesFlowOptions,
) => {
  const {
    logger,
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  prepareMessagesApiPayload(anthropicPayload, selectedModel)
  const recordUsage = createNoopUsageRecorder()

  debugJson(logger, "Translated Messages payload:", anthropicPayload)

  const response = await messagesApiFlowDependencies.createMessages(
    anthropicPayload,
    undefined,
    {
      anthropicBetaHeader,
      clientSignal: c.req?.raw?.signal,
      subagentMarker,
      upstreamRequestId: requestId,
      sessionId,
      compactType,
      requestId,
    },
  )

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, async (stream) => {
      let usage: NormalizedUsage = {}
      let messageStopSeen = false
      let errorSeen = false

      try {
        for await (const event of response) {
          const eventName = event.event
          const data = event.data ?? ""
          if (data === "[DONE]") {
            break
          }
          if (!data) {
            continue
          }
          debugLazy(logger, () => ["Messages raw stream event:", data])
          const parsedEvent = parseAnthropicStreamEvent(data)
          if (parsedEvent?.type === "message_start") {
            usage = mergeUsage(usage, {
              ...normalizeMessagesUsage(parsedEvent.message.usage),
            })
          } else if (parsedEvent?.type === "message_delta") {
            usage = mergeUsage(usage, {
              ...normalizeMessagesUsage(parsedEvent.usage),
            })
          }
          if (
            parsedEvent?.type === "message_stop"
            || eventName === "message_stop"
          ) {
            messageStopSeen = true
          } else if (parsedEvent?.type === "error" || eventName === "error") {
            errorSeen = true
          }
          await writeSSEIfConnected(stream, {
            event: eventName,
            data,
          })
        }
      } catch (error) {
        logger.warn("Messages stream interrupted:", error)
      }

      if (!messageStopSeen && !errorSeen) {
        logger.warn(
          "Messages stream ended without completion; sending error event",
        )
        const errorEvent = translateErrorToAnthropicErrorEvent()
        await writeSSEIfConnected(stream, {
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Non-streaming Messages result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage(normalizeMessagesUsage(response.usage))
  return c.json(response)
}

export const prepareCopilotChatCompletionsPayload = (
  payload: ChatCompletionsPayload,
): void => {
  applyCopilotContextCache(payload)
}

const applyCopilotContextCache = (payload: ChatCompletionsPayload): void => {
  const messageIndexes = selectCopilotContextCacheMessageIndexes(
    payload.messages,
  )
  for (const messageIndex of messageIndexes) {
    const message = payload.messages[messageIndex]
    message.copilot_cache_control = { ...COPILOT_CONTEXT_CACHE_CONTROL }
  }
}

const selectCopilotContextCacheMessageIndexes = (
  messages: Array<Message>,
): Array<number> => {
  const systemIndexes = messages
    .flatMap((message, index) =>
      message.role === "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .slice(0, COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT)
  const reverseNonSystemIndexes = messages
    .flatMap((message, index) =>
      message.role !== "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .reverse()
    .slice(0, COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT)

  return uniqueIndexes([...systemIndexes, ...reverseNonSystemIndexes]).sort(
    (a, b) => a - b,
  )
}

const isCopilotContextCacheEligible = (message: Message): boolean => {
  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}

const uniqueIndexes = (indexes: Array<number>): Array<number> => [
  ...new Set(indexes),
]

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createCopilotChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const createNoopUsageRecorder =
  (): ((usage: NormalizedUsage) => void) => () => {}

const mergeUsage = (
  current: NormalizedUsage,
  next: NormalizedUsage,
): NormalizedUsage => ({
  tokensInput: next.tokensInput ?? current.tokensInput,
  tokensOutput: next.tokensOutput ?? current.tokensOutput,
  tokensTotal: next.tokensTotal ?? current.tokensTotal,
  tokensCachedInput: next.tokensCachedInput ?? current.tokensCachedInput,
  usageJson: next.usageJson ?? current.usageJson,
})

const parseAnthropicStreamEvent = (
  data: string,
): AnthropicStreamEventData | null => {
  try {
    return JSON.parse(data) as AnthropicStreamEventData
  } catch {
    return null
  }
}
