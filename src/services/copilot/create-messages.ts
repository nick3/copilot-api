import consola from "consola"
import { events } from "fetch-event-stream"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { AccountContext } from "~/lib/types/account"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
  prepareMessageProxyHeaders,
} from "~/lib/api-config"
import { isForceAgentEnabled } from "~/lib/config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { captureOutboundHeadersSnapshot } from "~/lib/request-context"
import { resolveEffectiveInitiator } from "~/lib/request-initiator"
import { accountFromState } from "~/lib/state"
import { parseUserIdMetadata } from "~/lib/utils"

import { copilotFetch } from "./copilot-fetch"

const isAgentMessage = (
  msg: AnthropicMessagesPayload["messages"][number],
): boolean => {
  if (msg.role === "assistant") return true

  // user message with content that is entirely tool_result blocks
  // is semantically agent-driven (tool call response)
  if (Array.isArray(msg.content)) {
    const allToolResults = msg.content.every(
      (block) => block.type === "tool_result",
    )
    if (allToolResults && msg.content.length > 0) return true
  }

  return false
}

export const getMessagesInitiator = (
  payload: AnthropicMessagesPayload,
): "agent" | "user" => {
  if (isForceAgentEnabled()) {
    return payload.messages.some((msg) => isAgentMessage(msg)) ?
        "agent"
      : "user"
  }

  const lastMessage = payload.messages.at(-1)
  if (!lastMessage || lastMessage.role !== "user") {
    return "agent"
  }

  if (!Array.isArray(lastMessage.content)) {
    return "user"
  }

  const hasNonToolResult = lastMessage.content.some(
    (block) => block.type !== "tool_result",
  )
  return hasNonToolResult ? "user" : "agent"
}

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20"
const allowedAnthropicBetas = new Set([
  INTERLEAVED_THINKING_BETA,
  "context-management-2025-06-27",
  ADVANCED_TOOL_USE_BETA,
])

const TOOL_SEARCH_SUPPORTED_MODELS = [
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-opus-4.6",
] as const

const modelSupportsToolSearch = (modelId: string): boolean => {
  return TOOL_SEARCH_SUPPORTED_MODELS.some((prefix) =>
    modelId.toLowerCase().startsWith(prefix),
  )
}

const buildAnthropicBetaHeader = (
  anthropicBetaHeader: string | undefined,
  thinking: AnthropicMessagesPayload["thinking"],
  model: string,
): string | undefined => {
  const isAdaptiveThinking = thinking?.type === "adaptive"

  if (anthropicBetaHeader) {
    const filteredBeta = anthropicBetaHeader
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item) => allowedAnthropicBetas.has(item))
      .filter(
        (item) => !isAdaptiveThinking || item !== INTERLEAVED_THINKING_BETA,
      )

    // in vscode copilot extension, advanced-tool-use is enabled by default
    // align header with vscode copilot extension

    // remove this append once GitHub Copilot extension sends ADVANCED_TOOL_USE_BETA by default
    const copilotHeaderSet =
      modelSupportsToolSearch(model) ? [ADVANCED_TOOL_USE_BETA] : []
    const headerSet = new Set([...copilotHeaderSet, ...filteredBeta])
    const uniqueFilteredBetas = [...headerSet]

    if (uniqueFilteredBetas.length > 0) {
      return uniqueFilteredBetas.join(",")
    }

    return undefined
  }

  if (thinking?.budget_tokens && !isAdaptiveThinking) {
    return INTERLEAVED_THINKING_BETA
  }

  return undefined
}

const hasVisionInput = (payload: AnthropicMessagesPayload): boolean =>
  payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some(
        (block) =>
          block.type === "image"
          || (block.type === "tool_result"
            && Array.isArray(block.content)
            && block.content.some((inner) => inner.type === "image")),
      ),
  )

const shouldUseMessageProxyHeaders = (
  payload: AnthropicMessagesPayload,
): boolean => {
  const { safetyIdentifier, sessionId } = parseUserIdMetadata(
    payload.metadata?.user_id,
  )

  return Boolean(safetyIdentifier && sessionId)
}

const buildMessagesHeaders = ({
  ctx,
  enableVision,
  initiator,
  options,
  payload,
}: {
  ctx: AccountContext
  enableVision: boolean
  initiator: "agent" | "user"
  options:
    | {
        anthropicBetaHeader?: string
        upstreamRequestId?: string
        initiator?: "agent" | "user"
        subagentMarker?: SubagentMarker | null
        sessionId?: string
        compactType?: CompactType
        requestId?: string
      }
    | undefined
  payload: AnthropicMessagesPayload
}): Record<string, string> => {
  const isCompact = Boolean(options?.compactType)
  const effectiveInitiator = resolveEffectiveInitiator(initiator, {
    isCompact,
    isSubagent: Boolean(options?.subagentMarker),
  })

  const headers: Record<string, string> = {
    ...copilotHeaders(ctx, enableVision, options?.upstreamRequestId),
    "x-initiator": effectiveInitiator,
  }

  prepareInteractionHeaders(
    options?.sessionId,
    Boolean(options?.subagentMarker),
    headers,
  )

  prepareForCompact(headers, options?.compactType)

  // claude-opus-4.8 is excluded: Copilot's upstream WAF returns a generic
  // "Access to this endpoint is forbidden" 403 whenever a request carries
  // the Claude-Code-style user-agent without a `copilot-integration-id`
  // header. The exact same header set is accepted on claude-opus-4.7, so
  // the gate is a model-id rollout gap on Copilot's side. Skipping the
  // rewrite for 4.8 keeps the default Copilot identity
  // (copilot-integration-id: vscode-chat + GitHubCopilotChat UA +
  // conversation-agent intent) in place; that path is 200. Remove this
  // skip once Copilot's upstream accepts the Claude-Code identity on 4.8.
  // Probed 2026-05-29.
  if (
    shouldUseMessageProxyHeaders(payload)
    && payload.model !== "claude-opus-4.8"
  ) {
    prepareMessageProxyHeaders(headers)
  }

  const anthropicBeta = buildAnthropicBetaHeader(
    options?.anthropicBetaHeader,
    payload.thinking,
    payload.model,
  )
  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta
  }

  return headers
}

export const createMessages = async (
  payload: AnthropicMessagesPayload,
  account?: AccountContext,
  options?: {
    anthropicBetaHeader?: string
    upstreamRequestId?: string
    initiator?: "agent" | "user"
    subagentMarker?: SubagentMarker | null
    sessionId?: string
    compactType?: CompactType
    requestId?: string
    fetchImpl?: typeof fetch
  },
): Promise<CreateMessagesReturn> => {
  const ctx = account ?? accountFromState()
  if (!ctx.copilotToken) throw new Error("Copilot token not found")

  const enableVision = hasVisionInput(payload)
  const initiator = options?.initiator ?? getMessagesInitiator(payload)
  const headers = buildMessagesHeaders({
    ctx,
    enableVision,
    initiator,
    options,
    payload,
  })

  captureOutboundHeadersSnapshot(headers)

  const response = await copilotFetch(
    `${copilotBaseUrl(ctx)}/v1/messages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    {
      requestId: options?.requestId,
      callSite: "messages",
      fetchImpl: options?.fetchImpl,
    },
  )

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    consola.error("Failed to create messages", response)
    throw new HTTPError("Failed to create messages", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicResponse
}
