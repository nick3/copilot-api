import consola from "consola"
import { events } from "fetch-event-stream"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { AccountContext } from "~/lib/types/account"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { isForceAgentEnabled } from "~/lib/config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { captureOutboundHeadersSnapshot } from "~/lib/request-context"
import { resolveEffectiveInitiator } from "~/lib/request-initiator"
import { accountFromState } from "~/lib/state"

import { copilotFetch } from "./copilot-fetch"

export const getChatInitiator = (
  messages: Array<Message>,
): "agent" | "user" => {
  if (isForceAgentEnabled()) {
    const hasAgent = messages.some((msg) =>
      ["assistant", "tool"].includes(msg.role),
    )
    return hasAgent ? "agent" : "user"
  }

  const lastMessage = messages.at(-1)
  if (!lastMessage) return "user"

  return ["assistant", "tool"].includes(lastMessage.role) ? "agent" : "user"
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  account?: AccountContext,
  options?: {
    upstreamRequestId?: string
    initiator?: "agent" | "user"
    subagentMarker?: SubagentMarker | null
    sessionId?: string
    compactType?: CompactType
    requestId?: string
    fetchImpl?: typeof fetch
  },
) => {
  const ctx = account ?? accountFromState()
  if (!ctx.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const initiator = options?.initiator ?? getChatInitiator(payload.messages)
  const isCompact = Boolean(options?.compactType)

  const effectiveInitiator = resolveEffectiveInitiator(initiator, {
    isCompact,
    isSubagent: Boolean(options?.subagentMarker),
  })

  // Build headers and add x-initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(ctx, enableVision, options?.upstreamRequestId),
    "x-initiator": effectiveInitiator,
  }

  prepareInteractionHeaders(
    options?.sessionId,
    Boolean(options?.subagentMarker),
    headers,
  )

  const upstreamPayload = payload

  prepareForCompact(headers, options?.compactType)
  captureOutboundHeadersSnapshot(headers)

  const response = await copilotFetch(
    `${copilotBaseUrl(ctx)}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
    },
    {
      requestId: options?.requestId,
      callSite: "chat-completions",
      fetchImpl: options?.fetchImpl,
    },
  )

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  copilot_usage?: CopilotUsage | null
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    prompt_tokens_details?: {
      cache_creation_input_tokens?: number
      cached_tokens?: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

export interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
  reasoning_text?: string | null
  reasoning_content?: string | null
  reasoning_opaque?: string | null
}

export interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  copilot_usage?: CopilotUsage | null
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    prompt_tokens_details?: {
      cache_creation_input_tokens?: number
      cached_tokens?: number
    }
  }
}

export interface CopilotUsage {
  total_nano_aiu?: number | null
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_text?: string | null
  reasoning_content?: string | null
  reasoning_opaque?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  [key: string]: unknown

  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  reasoning_effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | null
  stream_options?: {
    include_usage?: boolean | null
  } | null
  thinking_budget?: number
  top_k?: number | null
  parallel_tool_calls?: boolean | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
  reasoning_content?: string | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  copilot_cache_control?: CopilotCacheControl
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart | FilePart

export interface CacheControl {
  type: "ephemeral"
}

export interface CopilotCacheControl {
  type: "ephemeral"
}

export interface TextPart {
  type: "text"
  text: string
  cache_control?: CacheControl
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
  cache_control?: CacheControl
}

export interface FilePart {
  type: "file"
  file: {
    file_data: string
    filename?: string
  }
  cache_control?: CacheControl
}
