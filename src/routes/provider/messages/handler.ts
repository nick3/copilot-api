import type { Context, Env } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
} from "~/services/copilot/create-chat-completions"

import {
  getProviderConfig,
  type ModelConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import {
  extractErrorObservability,
  getUserVisibleErrorMessage,
} from "~/lib/handler-utils"
import { createHandlerLogger, debugJson, debugLazy } from "~/lib/logger"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "~/routes/messages/non-stream-translation"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/stream-translation"
import {
  forwardProviderChatCompletions,
  forwardProviderMessages,
} from "~/services/providers/anthropic-proxy"

const logger = createHandlerLogger("provider-messages-handler")

type ProviderConfigResolver = (
  provider: string,
) => ResolvedProviderConfig | null

const getProviderFetch = (c: Context): typeof fetch =>
  (c.get("providerFetch" as never) as typeof fetch | undefined) ?? fetch

const resolveProviderConfig = (
  c: Context,
  provider: string,
): ResolvedProviderConfig | null => {
  const resolver = c.get("providerConfigResolver" as never) as
    | ProviderConfigResolver
    | undefined
  return (resolver ?? getProviderConfig)(provider)
}

const OPENAI_COMPATIBLE_CONTEXT_CACHE_MARKER_LIMIT = 4
const OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL = {
  type: "ephemeral",
} as const
const OPENAI_COMPATIBLE_CONTEXT_CACHE_ROLES = new Set<Message["role"]>([
  "system",
  "user",
  "assistant",
  "tool",
])

export type UsageTokens = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export type ProviderStreamError = {
  errorMessage: string
  errorName: string
  errorStatus?: number
  httpStatus: number
  upstreamErrorMessageRaw?: string
}

export type ProviderMessagesInstrumentation = {
  onComplete?: (usage: UsageTokens) => void
  onError?: (error: ProviderStreamError) => void
}

const writeProviderStreamError = async (
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  message: string,
): Promise<void> => {
  try {
    await stream.writeSSE({
      event: "error",
      data: JSON.stringify({
        error: {
          message,
          type: "api_error",
        },
        type: "error",
      }),
    })
  } catch (error) {
    logger.warn("Failed to write provider stream error event", error)
  }
}

export async function handleProviderMessages(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  return await handleProviderMessagesForProvider(c, { payload, provider })
}

export async function handleProviderMessagesForProvider(
  c: Context,
  options: {
    instrumentation?: ProviderMessagesInstrumentation
    payload: AnthropicMessagesPayload
    provider: string
  },
): Promise<Response> {
  const { instrumentation, payload, provider } = options
  const providerConfig = resolveProviderConfig(c, provider)
  if (!providerConfig) {
    const message = `Provider '${provider}' not found or disabled`
    instrumentation?.onError?.({
      errorMessage: message,
      errorName: "ProviderNotFoundError",
      errorStatus: 404,
      httpStatus: 404,
    })
    return c.json(
      {
        error: {
          message,
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  try {
    const modelConfig = providerConfig.models?.[payload.model]
    applyModelDefaults(payload, modelConfig)

    debugJson(logger, "provider.messages.request", { payload, provider })

    if (providerConfig.type === "openai-compatible") {
      return await handleOpenAICompatibleProviderMessages(c, {
        instrumentation,
        modelConfig,
        payload,
        provider,
        providerConfig,
      })
    }

    applyMissingExtraBody(payload as unknown as Record<string, unknown>, {
      extraBody: modelConfig?.extraBody,
    })

    const upstreamResponse = await forwardProviderMessages(
      providerConfig,
      payload,
      c.req.raw.headers,
      getProviderFetch(c),
    )

    if (!upstreamResponse.ok) {
      logger.error("Failed to create responses", upstreamResponse)
      throw new HTTPError("Failed to create responses", upstreamResponse)
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? ""
    const isStreamingResponse =
      Boolean(payload.stream) && contentType.includes("text/event-stream")

    if (isStreamingResponse) {
      return streamProviderMessages({
        c,
        instrumentation,
        payload,
        provider,
        providerConfig,
        upstreamResponse,
      })
    }

    const jsonBody = (await upstreamResponse.json()) as AnthropicResponse
    return respondProviderMessagesJson(c, {
      body: jsonBody,
      instrumentation,
      payload,
      provider,
      providerConfig,
    })
  } catch (error) {
    logger.error("provider.messages.error", {
      provider,
      error,
    })
    throw error
  }
}

const applyModelDefaults = (
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig | undefined,
): void => {
  payload.temperature ??= modelConfig?.temperature
  payload.top_p ??= modelConfig?.topP
  payload.top_k ??= modelConfig?.topK
}

const applyMissingExtraBody = (
  payload: Record<string, unknown>,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  for (const [key, value] of Object.entries(options.extraBody ?? {})) {
    if (!Object.hasOwn(payload, key)) {
      payload[key] = value
    }
  }
}

const handleOpenAICompatibleProviderMessages = async (
  c: Context,
  options: {
    instrumentation?: ProviderMessagesInstrumentation
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { instrumentation, modelConfig, payload, provider, providerConfig } =
    options
  const openAIPayload = createOpenAICompatiblePayload(payload, modelConfig)
  debugJson(logger, "provider.messages.openai_compatible.request", {
    payload: openAIPayload,
    provider,
  })

  const upstreamResponse = await forwardProviderChatCompletions(
    providerConfig,
    openAIPayload,
    c.req.raw.headers,
    getProviderFetch(c),
  )

  if (!upstreamResponse.ok) {
    logger.error(
      "Failed to create openai-compatible responses",
      upstreamResponse,
    )
    throw new HTTPError(
      "Failed to create openai-compatible responses",
      upstreamResponse,
    )
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  const isStreamingResponse =
    Boolean(openAIPayload.stream) && contentType.includes("text/event-stream")

  if (isStreamingResponse) {
    return streamOpenAICompatibleProviderMessages({
      c,
      instrumentation,
      payload,
      provider,
      upstreamResponse,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ChatCompletionResponse
  return respondOpenAICompatibleProviderMessagesJson(c, {
    body: jsonBody,
    instrumentation,
    payload,
    provider,
  })
}

const createOpenAICompatiblePayload = (
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig | undefined,
): ChatCompletionsPayload => {
  const openAIPayload = translateToOpenAI(payload, {
    supportPdf: modelConfig?.supportPdf,
    toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
  })

  if (payload.top_k !== undefined) {
    openAIPayload.top_k = payload.top_k
  }

  if (openAIPayload.stream) {
    openAIPayload.stream_options = {
      include_usage: true,
    }
  }

  normalizeOpenAICompatibleReasoningContent(openAIPayload)

  applyOpenAICompatibleRequestOverrides(openAIPayload, {
    extraBody: modelConfig?.extraBody,
    source: payload as unknown as Record<string, unknown>,
  })

  applyMissingExtraBody(openAIPayload, {
    extraBody: modelConfig?.extraBody,
  })

  if (!Object.hasOwn(openAIPayload, "parallel_tool_calls")) {
    openAIPayload.parallel_tool_calls = true
  }

  if (modelConfig?.contextCache !== false) {
    applyOpenAICompatibleContextCache(openAIPayload)
  }

  return openAIPayload
}

const normalizeOpenAICompatibleReasoningContent = (
  payload: ChatCompletionsPayload,
): void => {
  for (const message of payload.messages) {
    if (message.role !== "assistant") {
      continue
    }

    if (
      message.reasoning_content === undefined
      && message.reasoning_text !== undefined
    ) {
      message.reasoning_content = message.reasoning_text
    }

    delete message.reasoning_text
    delete message.reasoning_opaque
  }
}

const applyOpenAICompatibleRequestOverrides = (
  payload: ChatCompletionsPayload,
  options: {
    extraBody: Record<string, unknown> | undefined
    source: Record<string, unknown>
  },
): void => {
  const allowedKeys = new Set(Object.keys(options.extraBody ?? {}))
  for (const key of allowedKeys) {
    if (Object.hasOwn(options.source, key)) {
      payload[key] = options.source[key]
    }
  }
}

const applyOpenAICompatibleContextCache = (
  payload: ChatCompletionsPayload,
): void => {
  const messageIndexes = selectContextCacheMessageIndexes(payload.messages)
  for (const messageIndex of messageIndexes) {
    applyContextCacheControl(payload.messages[messageIndex])
  }
}

const selectContextCacheMessageIndexes = (
  messages: Array<Message>,
): Array<number> => {
  const cacheableIndexes = messages.flatMap((message, index) =>
    isContextCacheMarkerEligible(message) ? [index] : [],
  )
  const systemIndexes = cacheableIndexes
    .filter((index) => messages[index]?.role === "system")
    .slice(0, 2)
  const finalIndexes = cacheableIndexes
    .filter((index) => messages[index]?.role !== "system")
    .slice(-2)
  return uniqueIndexes([...systemIndexes, ...finalIndexes]).sort(
    (a, b) => a - b,
  )
}

const uniqueIndexes = (indexes: Array<number>): Array<number> =>
  [...new Set(indexes)].slice(0, OPENAI_COMPATIBLE_CONTEXT_CACHE_MARKER_LIMIT)

const isContextCacheMarkerEligible = (message: Message): boolean => {
  if (!OPENAI_COMPATIBLE_CONTEXT_CACHE_ROLES.has(message.role)) {
    return false
  }

  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}

const applyContextCacheControl = (message: Message | undefined): void => {
  if (!message) {
    return
  }

  if (typeof message.content === "string") {
    message.content = [
      {
        type: "text",
        text: message.content,
        cache_control: { ...OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL },
      },
    ]
    return
  }

  if (!Array.isArray(message.content)) {
    return
  }

  const lastPart = message.content.at(-1)
  if (!lastPart) {
    return
  }
  setContextCacheControl(lastPart)
}

const setContextCacheControl = (part: ContentPart): void => {
  part.cache_control = { ...OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL }
}

const streamProviderMessages = ({
  c,
  instrumentation,
  providerConfig,
  upstreamResponse,
}: {
  c: Context
  instrumentation?: ProviderMessagesInstrumentation
  payload: AnthropicMessagesPayload
  provider: string
  providerConfig: ResolvedProviderConfig
  upstreamResponse: Response
}): Response => {
  logger.debug("provider.messages.streaming")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    try {
      let completed = false
      for await (const chunk of events(upstreamResponse)) {
        logger.debug("provider.messages.raw_stream_event:", chunk.data)
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        let data = chunk.data
        if (!data) {
          continue
        }

        if (chunk.data === "[DONE]") {
          completed = true
          break
        }

        const parsed = parseProviderStreamEvent(data, providerConfig)
        usage = mergeAnthropicUsage(usage, parsed.usage)
        data = parsed.data

        await stream.writeSSE({
          event: eventName,
          data,
        })

        if (parsed.error || eventName === "error") {
          instrumentation?.onError?.(
            parsed.error ?? {
              errorMessage: data,
              errorName: "ProviderStreamError",
              httpStatus: 500,
            },
          )
          return
        }
        completed ||= parsed.done
      }

      if (!completed) {
        throw new Error("Provider messages stream ended before completion")
      }
      instrumentation?.onComplete?.(usage)
    } catch (error) {
      const details = await extractErrorObservability(error)
      logger.warn("provider.messages.streaming.error", error)
      instrumentation?.onError?.(details)
      await writeProviderStreamError(
        stream,
        getUserVisibleErrorMessage(details),
      )
    }
  })
}

const streamOpenAICompatibleProviderMessages = ({
  c,
  instrumentation,
  upstreamResponse,
}: {
  c: Context
  instrumentation?: ProviderMessagesInstrumentation
  payload: AnthropicMessagesPayload
  provider: string
  upstreamResponse: Response
}): Response => {
  logger.debug("provider.messages.openai_compatible.streaming")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    try {
      let completed = false
      for await (const chunk of events(upstreamResponse)) {
        logger.debug(
          "provider.messages.openai_compatible.raw_stream_event:",
          chunk.data,
        )
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        if (!chunk.data) {
          continue
        }
        if (chunk.data === "[DONE]") {
          completed = true
          break
        }

        const parsed = parseOpenAICompatibleStreamChunk(chunk.data)

        if (parsed.usage) {
          usage = normalizeOpenAIUsage(parsed.usage)
        }

        const events = translateChunkToAnthropicEvents(parsed, streamState)
        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => [
            "provider.messages.openai_compatible.translated_event:",
            eventData,
          ])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
          completed ||= event.type === "message_stop"
        }
      }

      for (const event of flushPendingAnthropicStreamEvents(streamState)) {
        const eventData = JSON.stringify(event)
        debugLazy(logger, () => [
          "provider.messages.openai_compatible.translated_event:",
          eventData,
        ])
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
        completed ||= event.type === "message_stop"
      }

      if (!completed) {
        throw new Error(
          "OpenAI-compatible provider messages stream ended before completion",
        )
      }
      instrumentation?.onComplete?.(usage)
    } catch (error) {
      const details = await extractErrorObservability(error)
      logger.warn("provider.messages.openai_compatible.streaming.error", error)
      instrumentation?.onError?.(details)
      await writeProviderStreamError(
        stream,
        getUserVisibleErrorMessage(details),
      )
    }
  })
}

const parseOpenAICompatibleStreamChunk = (
  data: string,
): ChatCompletionChunk => {
  let parsed: ChatCompletionChunk & { error?: unknown }
  try {
    parsed = JSON.parse(data) as ChatCompletionChunk & { error?: unknown }
  } catch (error) {
    logger.error("provider.messages.openai_compatible.parse_chunk_error", {
      data,
      error,
    })
    throw new Error("Failed to parse OpenAI-compatible stream chunk", {
      cause: error,
    })
  }

  const streamErrorMessage = getOpenAICompatibleStreamErrorMessage(parsed.error)
  if (streamErrorMessage) {
    throw new Error(streamErrorMessage)
  }

  return parsed
}

const getOpenAICompatibleStreamErrorMessage = (
  error: unknown,
): string | null => {
  if (typeof error === "string") {
    return error
  }
  if (!error || typeof error !== "object") {
    return null
  }

  const message = (error as { message?: unknown }).message
  return typeof message === "string" ? message : JSON.stringify(error)
}

const parseProviderStreamEvent = (
  data: string,
  providerConfig: ResolvedProviderConfig,
): {
  data: string
  done: boolean
  error?: ProviderStreamError
  model?: string
  usage: UsageTokens
} => {
  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    if (parsed.type === "message_start") {
      adjustInputTokens(providerConfig, parsed.message.usage)
      return {
        data: JSON.stringify(parsed),
        done: false,
        model: parsed.message.model,
        usage: normalizeAnthropicUsage(parsed.message.usage),
      }
    }
    if (parsed.type === "message_delta") {
      adjustInputTokens(providerConfig, parsed.usage)
      return {
        data: JSON.stringify(parsed),
        done: false,
        usage: normalizeAnthropicUsage(parsed.usage),
      }
    }
    if (parsed.type === "message_stop") {
      return { data: JSON.stringify(parsed), done: true, usage: {} }
    }
    if (parsed.type === "error") {
      return {
        data: JSON.stringify(parsed),
        done: false,
        error: {
          errorMessage: parsed.error.message,
          errorName: parsed.error.type,
          httpStatus: 500,
        },
        usage: {},
      }
    }
    return { data: JSON.stringify(parsed), done: false, usage: {} }
  } catch (error) {
    logger.error("provider.messages.streaming.adjust_tokens_error", {
      error,
      originalData: data,
    })
    throw new Error("Failed to parse provider messages stream event", {
      cause: error,
    })
  }
}

const respondProviderMessagesJson = (
  c: Context,
  options: {
    body: AnthropicResponse
    instrumentation?: ProviderMessagesInstrumentation
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Response => {
  const { body, instrumentation, providerConfig } = options
  adjustInputTokens(providerConfig, body.usage)

  debugJson(logger, "provider.messages.no_stream result:", body)
  const response = c.json(body)
  instrumentation?.onComplete?.(normalizeAnthropicUsage(body.usage))
  return response
}

const respondOpenAICompatibleProviderMessagesJson = (
  c: Context,
  options: {
    body: ChatCompletionResponse
    instrumentation?: ProviderMessagesInstrumentation
    payload: AnthropicMessagesPayload
    provider: string
  },
): Response => {
  const { body, instrumentation } = options
  const anthropicResponse = translateToAnthropic(body)
  debugJson(
    logger,
    "provider.messages.openai_compatible.no_stream result:",
    anthropicResponse,
  )
  const response = c.json(anthropicResponse)
  instrumentation?.onComplete?.(normalizeOpenAIUsage(body.usage))
  return response
}

const normalizeOpenAIUsage = (
  usage: ChatCompletionResponse["usage"] | ChatCompletionChunk["usage"],
): UsageTokens => {
  const cacheCreationInputTokens =
    usage?.prompt_tokens_details?.cache_creation_input_tokens
  const cacheReadInputTokens = usage?.prompt_tokens_details?.cached_tokens
  const inputTokens =
    usage?.prompt_tokens === undefined ?
      undefined
    : Math.max(
        0,
        usage.prompt_tokens
          - (cacheCreationInputTokens ?? 0)
          - (cacheReadInputTokens ?? 0),
      )

  return {
    inputTokens,
    outputTokens: usage?.completion_tokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  }
}

const normalizeAnthropicUsage = (
  usage?: AnthropicResponse["usage"] | AnthropicMessageUsage,
): UsageTokens => ({
  inputTokens: usage?.input_tokens,
  outputTokens: usage?.output_tokens,
  cacheCreationInputTokens: usage?.cache_creation_input_tokens,
  cacheReadInputTokens: usage?.cache_read_input_tokens,
})

const mergeAnthropicUsage = (
  current: UsageTokens,
  next: UsageTokens,
): UsageTokens => ({
  inputTokens: next.inputTokens ?? current.inputTokens,
  outputTokens: next.outputTokens ?? current.outputTokens,
  cacheCreationInputTokens:
    next.cacheCreationInputTokens ?? current.cacheCreationInputTokens,
  cacheReadInputTokens:
    next.cacheReadInputTokens ?? current.cacheReadInputTokens,
})

type AnthropicMessageUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const adjustInputTokens = (
  providerConfig: ResolvedProviderConfig,
  usage?: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
): void => {
  if (!providerConfig.adjustInputTokens || !usage) {
    return
  }
  const adjustedInput = Math.max(
    0,
    (usage.input_tokens ?? 0)
      - (usage.cache_read_input_tokens ?? 0)
      - (usage.cache_creation_input_tokens ?? 0),
  )
  usage.input_tokens = adjustedInput
  debugJson(logger, "provider.messages.adjusted_usage:", usage)
}
