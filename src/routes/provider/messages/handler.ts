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
} from "~/services/copilot/create-chat-completions"

import {
  getProviderConfig,
  type ModelConfig,
  type ResolvedProviderConfig,
  resolveEffectiveProviderConfig,
} from "~/lib/config"
import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import {
  applyDashScopePreserveThinkingDefault,
  applyOpenAICompatibleContextCache,
  isDashScopeAliyunProvider,
} from "~/lib/dashscope"
import { HTTPError } from "~/lib/error"
import {
  extractErrorObservability,
  getUserVisibleErrorMessage,
} from "~/lib/handler-utils"
import { createHandlerLogger, debugJson, debugLazy } from "~/lib/logger"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "~/routes/messages/non-stream-translation"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/stream-translation"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { normalizeSystemMessages } from "~/routes/messages/preprocess"
import {
  assertWebSearchResponsesResultSucceeded,
  collectWebSearchResponsesStreamResult,
  hasWebSearchServerTool,
  isWebSearchOnlyRequest,
  prepareWebSearchResponsesPayload,
  reconstructWebSearchResponse,
  stripWebSearchServerTool,
  writeSyntheticWebSearchResponseStream,
} from "~/routes/messages/web-search/fulfill"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import { forwardCodexResponses } from "~/services/codex/create-responses"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import type {
  ResponsesResult,
  ResponseStreamEvent,
  ResponsesStream,
} from "~/services/copilot/create-responses"
import {
  forwardProviderChatCompletions,
  forwardProviderMessages,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"

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
    const effectiveProviderConfig = resolveEffectiveProviderConfig(
      providerConfig,
      payload.model,
    )
    const effectiveType = effectiveProviderConfig.type
    debugJson(logger, "provider.messages.request", { payload, provider })

    normalizeSystemMessages(payload)
    applyModelDefaults(payload, modelConfig)

    if (effectiveType === "openai-responses") {
      if (hasWebSearchServerTool(payload)) {
        if (isWebSearchOnlyRequest(payload)) {
          return await handleOpenAIResponsesProviderWebSearchMessages(c, {
            instrumentation,
            payload,
            provider,
            providerConfig: effectiveProviderConfig,
          })
        }

        stripWebSearchServerTool(payload)
      }

      return await handleOpenAIResponsesProviderMessages(c, {
        instrumentation,
        modelConfig,
        payload,
        provider,
        providerConfig: effectiveProviderConfig,
      })
    }

    if (effectiveType === "openai-compatible") {
      stripWebSearchServerTool(payload)

      return await handleOpenAICompatibleProviderMessages(c, {
        instrumentation,
        modelConfig,
        payload,
        provider,
        providerConfig: effectiveProviderConfig,
      })
    }

    applyMissingExtraBody(payload as unknown as Record<string, unknown>, {
      extraBody: modelConfig?.extraBody,
    })

    const upstreamResponse = await forwardProviderMessages(
      effectiveProviderConfig,
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
        providerConfig: effectiveProviderConfig,
        upstreamResponse,
      })
    }

    const jsonBody = (await upstreamResponse.json()) as AnthropicResponse
    return respondProviderMessagesJson(c, {
      body: jsonBody,
      instrumentation,
      payload,
      provider,
      providerConfig: effectiveProviderConfig,
    })
  } catch (error) {
    logger.error("provider.messages.error", {
      provider,
      error,
    })
    throw error
  }
}

const handleOpenAIResponsesProviderWebSearchMessages = async (
  c: Context,
  options: {
    instrumentation?: ProviderMessagesInstrumentation
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { instrumentation, payload, provider, providerConfig } = options
  const selectedModel =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined
  const responsesPayload = prepareWebSearchResponsesPayload(payload)
  responsesPayload.stream = true

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(responsesPayload)

  debugJson(logger, "provider.messages.responses.web_search.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
    )

    if (isResponsesStream(upstreamResponse)) {
      const body = await collectWebSearchResponsesStreamResult({
        errorMessagePrefix: `${provider} web search responses stream`,
        parseEvent: (data) =>
          parseResponsesProviderStreamChunk(data, providerConfig),
        upstreamResponse,
        logger,
      })
      return respondWebSearchProviderMessagesJson(c, {
        body,
        instrumentation,
        payload,
        provider,
      })
    }

    return respondWebSearchProviderMessagesJson(c, {
      body: upstreamResponse,
      instrumentation,
      payload,
      provider,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider web search responses", {
      provider,
      upstreamResponse,
    })
    throw new HTTPError(
      "Failed to create provider web search responses",
      upstreamResponse,
    )
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    const body = await collectWebSearchResponsesStreamResult({
      errorMessagePrefix: `${provider} web search responses stream`,
      parseEvent: (data) =>
        parseResponsesProviderStreamChunk(data, providerConfig),
      upstreamResponse: events(upstreamResponse),
      logger,
    })
    return respondWebSearchProviderMessagesJson(c, {
      body,
      instrumentation,
      payload,
      provider,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondWebSearchProviderMessagesJson(c, {
    body: jsonBody,
    instrumentation,
    payload,
    provider,
  })
}

const handleOpenAIResponsesProviderMessages = async (
  c: Context,
  options: {
    instrumentation?: ProviderMessagesInstrumentation
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { instrumentation, payload, provider, providerConfig } = options
  const selectedModel =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(payload)

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(responsesPayload)

  debugJson(logger, "provider.messages.responses.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
    )

    if (responsesPayload.stream && isResponsesStream(upstreamResponse)) {
      return streamResponsesProviderMessages({
        c,
        instrumentation,
        payload,
        provider,
        providerConfig,
        upstreamResponse,
      })
    }

    return respondResponsesProviderMessagesJson(c, {
      body: upstreamResponse as ResponsesResult,
      instrumentation,
      payload,
      provider,
      providerConfig,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider responses", upstreamResponse)
    throw new HTTPError("Failed to create provider responses", upstreamResponse)
  }

  if (responsesPayload.stream) {
    return streamResponsesProviderMessages({
      c,
      payload,
      provider,
      providerConfig,
      upstreamResponse: events(upstreamResponse),
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondResponsesProviderMessagesJson(c, {
    body: jsonBody,
    instrumentation,
    payload,
    provider,
    providerConfig,
  })
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

const getRequestThinkingBudget = (
  payload: AnthropicMessagesPayload,
): number | undefined => {
  const budget = payload.thinking?.budget_tokens
  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    return undefined
  }
  return budget
}

const applyOpenAICompatibleThinkingBudget = (
  payload: ChatCompletionsPayload,
  source: AnthropicMessagesPayload,
): void => {
  const thinkingBudget = getRequestThinkingBudget(source)
  if (thinkingBudget !== undefined) {
    payload.thinking_budget = thinkingBudget
    return
  }

  if (payload.thinking_budget === undefined) {
    delete payload.thinking_budget
  }
}

const applyOpenAICompatibleExtraBodyThinkingBudget = (
  payload: ChatCompletionsPayload,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  const { extraBody } = options
  if (!extraBody || !Object.hasOwn(extraBody, "thinking_budget")) {
    return
  }

  const rawPayload = payload as Record<string, unknown>
  rawPayload.thinking_budget = extraBody.thinking_budget
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
  const openAIPayload = createOpenAICompatiblePayload(
    payload,
    modelConfig,
    providerConfig,
  )
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
  providerConfig: ResolvedProviderConfig,
): ChatCompletionsPayload => {
  const openAIPayload = translateToOpenAI(payload, {
    supportPdf: modelConfig?.supportPdf,
    toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
  })

  const isDashScopeProvider = isDashScopeAliyunProvider(providerConfig)

  if (isDashScopeProvider) {
    applyOpenAICompatibleThinkingBudget(openAIPayload, payload)
  } else {
    delete openAIPayload.thinking_budget
  }

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

  applyOpenAICompatibleExtraBodyThinkingBudget(openAIPayload, {
    extraBody: modelConfig?.extraBody,
  })

  applyDashScopePreserveThinkingDefault(openAIPayload, providerConfig)

  if (!Object.hasOwn(openAIPayload, "parallel_tool_calls")) {
    openAIPayload.parallel_tool_calls = true
  }

  const contextCacheEnabled = modelConfig?.contextCache ?? isDashScopeProvider
  if (contextCacheEnabled) {
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

const streamResponsesProviderMessages = ({
  c,
  instrumentation,
  payload,
  provider,
  providerConfig,
  upstreamResponse,
}: {
  c: Context
  instrumentation?: ProviderMessagesInstrumentation
  payload: AnthropicMessagesPayload
  provider: string
  providerConfig: ResolvedProviderConfig
  upstreamResponse: ResponsesStream
}): Response => {
  logger.debug("provider.messages.responses.streaming", { provider })
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const streamState = createResponsesStreamState({
      toolSearchName: resolveBridgeToolSearchName(payload.tools),
    })

    try {
      for await (const chunk of upstreamResponse) {
        logger.debug(
          "provider.messages.responses.raw_stream_event:",
          chunk.data,
        )
        if (chunk.event === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        if (!chunk.data || chunk.data === "[DONE]") {
          if (chunk.data === "[DONE]") break
          continue
        }

        const parsed = parseResponsesProviderStreamChunk(
          chunk.data,
          providerConfig,
        )
        if (!parsed) continue

        if (
          parsed.type === "response.completed"
          || parsed.type === "response.failed"
          || parsed.type === "response.incomplete"
        ) {
          usage = normalizeResponsesUsage(parsed.response.usage)
        }

        const events = translateResponsesStreamEvent(parsed, streamState)
        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => [
            "provider.messages.responses.translated_event:",
            eventData,
          ])
          await stream.writeSSE({ event: event.type, data: eventData })
        }
      }

      if (!streamState.messageCompleted) {
        const errorEvent = buildErrorEvent(
          `${provider} stream ended without a completion event`,
        )
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }

      instrumentation?.onComplete?.(usage)
    } catch (error) {
      const details = await extractErrorObservability(error)
      logger.warn("provider.messages.responses.streaming.error", error)
      instrumentation?.onError?.(details)
      await writeProviderStreamError(
        stream,
        getUserVisibleErrorMessage(details),
      )
    }
  })
}

const isResponsesStream = (value: unknown): value is ResponsesStream =>
  Boolean(value)
  && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"

const parseResponsesProviderStreamChunk = (
  data: string,
  providerConfig: ResolvedProviderConfig,
): ResponseStreamEvent | null => {
  try {
    const parsed = JSON.parse(data) as ResponseStreamEvent
    if (providerConfig.name === "codex") {
      logCodexRateLimitsEvent(parsed)
    }

    return parsed
  } catch (error) {
    logger.error("provider.messages.responses.parse_chunk_error", {
      provider: providerConfig.name,
      data,
      error,
    })
    return null
  }
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

const respondResponsesProviderMessagesJson = (
  c: Context,
  options: {
    body: ResponsesResult
    instrumentation?: ProviderMessagesInstrumentation
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Response => {
  const { body, instrumentation, payload, providerConfig } = options
  const usage = normalizeResponsesUsage(body.usage)
  instrumentation?.onComplete?.(usage)

  const anthropicResponse = translateResponsesResultToAnthropic(body, {
    toolSearchName: resolveBridgeToolSearchName(payload.tools),
  })
  debugJson(
    logger,
    "provider.messages.responses.no_stream result:",
    anthropicResponse,
  )

  if (providerConfig.name === "codex") {
    logger.debug("provider.messages.codex.no_stream.result")
  }
  return c.json(anthropicResponse)
}

const respondWebSearchProviderMessagesJson = (
  c: Context,
  options: {
    body: ResponsesResult
    instrumentation?: ProviderMessagesInstrumentation
    payload: AnthropicMessagesPayload
    provider: string
  },
): Response => {
  const { body, instrumentation, payload, provider } = options
  assertWebSearchResponsesResultSucceeded(
    body,
    `${provider} web search responses`,
  )
  const usage = normalizeResponsesUsage(body.usage)
  instrumentation?.onComplete?.(usage)

  const { extract, response } = reconstructWebSearchResponse(payload, body, {
    requestId: body.id || `${provider}:${payload.model}`,
  })
  logger.debug(
    `provider.messages.responses.web_search: ${extract.queries.length} quer(y/ies), ${extract.sources.length} source(s)`,
  )

  if (!payload.stream) {
    return c.json(response)
  }

  return streamSSE(c, (stream) =>
    writeSyntheticWebSearchResponseStream(stream, response),
  )
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
