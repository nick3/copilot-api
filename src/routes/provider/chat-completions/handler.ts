import { events } from "fetch-event-stream"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { ModelConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  createProviderTokenUsageRecorder,
  normalizeOpenAIUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createProviderProxyResponse,
  forwardProviderChatCompletions,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-chat-completions-handler")

export async function handleProviderChatCompletionsForProvider(
  c: Context,
  options: {
    payload: ChatCompletionsPayload
    provider: string
  },
): Promise<Response> {
  const { payload, provider } = options
  const providerConfig = await resolveProviderConfig(provider)
  if (providerConfig?.type !== "openai-compatible") {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' does not support the /v1/chat/completions endpoint`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const modelConfig = providerConfig.models?.[payload.model]
  applyProviderModelDefaults(payload, modelConfig)
  applyMissingExtraBody(payload, {
    extraBody: modelConfig?.extraBody,
  })
  applyProviderStreamOptions(payload)

  debugJson(logger, "provider.chat_completions.request", {
    payload,
    provider,
  })

  const upstreamResponse = await forwardProviderChatCompletions(
    providerConfig,
    payload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider chat completions", {
      provider,
      statusCode: upstreamResponse.status,
    })
    throw new HTTPError(
      `Failed to create ${provider} chat completions`,
      upstreamResponse,
    )
  }

  const recordUsage = createProviderChatCompletionsUsageRecorder(
    payload,
    provider,
  )
  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  const isStreamingResponse =
    Boolean(payload.stream) && contentType.includes("text/event-stream")

  if (isStreamingResponse) {
    return streamProviderChatCompletions(c, upstreamResponse, {
      provider,
      recordUsage,
    })
  }

  const responseBody = (await upstreamResponse
    .clone()
    .json()) as ChatCompletionResponse
  recordUsage(normalizeOpenAIUsage(responseBody.usage))

  debugJson(logger, "provider.chat_completions.response", responseBody)
  return createProviderProxyResponse(upstreamResponse)
}

const applyProviderModelDefaults = (
  payload: ChatCompletionsPayload,
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

const applyProviderStreamOptions = (payload: ChatCompletionsPayload): void => {
  if (!payload.stream) {
    return
  }

  payload.stream_options = {
    ...(payload.stream_options ?? {}),
    include_usage: true,
  }
}

const createProviderChatCompletionsUsageRecorder = (
  payload: ChatCompletionsPayload,
  provider: string,
) =>
  createProviderTokenUsageRecorder({
    endpoint: "chat_completions",
    model: payload.model,
    providerName: provider,
  })

const streamProviderChatCompletions = (
  c: Context,
  upstreamResponse: Response,
  options: {
    provider: string
    recordUsage: (usage: UsageTokens) => void
  },
): Response => {
  logger.debug("provider.chat_completions.streaming", {
    provider: options.provider,
  })
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    try {
      for await (const chunk of events(upstreamResponse)) {
        debugJson(logger, "provider.chat_completions.stream_chunk", chunk)
        if (chunk.data && chunk.data !== "[DONE]") {
          const parsedChunk = parseChatCompletionChunkData(chunk.data)
          if (parsedChunk?.usage) {
            usage = normalizeOpenAIUsage(parsedChunk.usage)
          }
        }

        await stream.writeSSE({
          event: chunk.event,
          data: chunk.data ?? "",
        })
      }
    } finally {
      options.recordUsage(usage)
    }
  })
}

const parseChatCompletionChunkData = (
  data: string,
): ChatCompletionChunk | null => {
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}
