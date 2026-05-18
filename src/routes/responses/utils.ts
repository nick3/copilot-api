import type {
  ResponseContextManagementCompactionItem,
  ResponseInputItem,
  ResponsesPayload,
  ResponsesTransport,
} from "~/services/copilot/create-responses"

import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  isForceAgentEnabled,
  isResponsesApiContextManagementModel as isConfiguredResponsesApiContextManagementModel,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"

export const RESPONSES_ENDPOINT = "/responses"
export const RESPONSES_WS_ENDPOINT = "ws:/responses"

export const responsesUtilsDependencies = {
  isResponsesApiContextManagementModel:
    isConfiguredResponsesApiContextManagementModel,
  isResponsesApiWebSocketEnabled: isConfiguredResponsesApiWebSocketEnabled,
}

export const getResponsesRequestOptions = (
  payload: ResponsesPayload,
): { vision: boolean; initiator: "agent" | "user" } => {
  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? "agent" : "user"

  return { vision, initiator }
}

export const getResponsesTransportForModel = (
  selectedModel:
    | {
        supported_endpoints?: Array<string>
      }
    | undefined,
  options: {
    compactType?: CompactType
  } = {},
): ResponsesTransport | null => {
  const supportedEndpoints = selectedModel?.supported_endpoints ?? []
  const useWebSocket =
    responsesUtilsDependencies.isResponsesApiWebSocketEnabled()

  if (
    options.compactType !== COMPACT_REQUEST
    && useWebSocket
    && supportedEndpoints.includes(RESPONSES_WS_ENDPOINT)
  ) {
    return "websocket"
  }

  if (supportedEndpoints.includes(RESPONSES_ENDPOINT)) {
    return "http"
  }

  return null
}

export const hasAgentInitiator = (payload: ResponsesPayload): boolean => {
  const items = getPayloadItems(payload)

  if (isForceAgentEnabled()) {
    // forceAgent mode: check if ANY item has assistant role
    return items.some((item) => isAgentRole(item))
  }

  // Default mode: only check the last item
  const lastItem = items.at(-1)
  if (!lastItem) {
    return false
  }
  return isAgentRole(lastItem)
}

// Helper function: check if a single item has agent role
const isAgentRole = (item: ResponseInputItem): boolean => {
  if (!("role" in item) || !item.role) {
    return true // No role means agent (preserve original logic)
  }
  const role = typeof item.role === "string" ? item.role.toLowerCase() : ""
  return role === "assistant"
}

export const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

export const resolveResponsesCompactThreshold = (
  maxPromptTokens?: number,
): number => {
  if (typeof maxPromptTokens === "number" && maxPromptTokens > 0) {
    return Math.floor(maxPromptTokens * 0.9)
  }

  return 50000
}

const createCompactionContextManagement = (
  compactThreshold: number,
): Array<ResponseContextManagementCompactionItem> => [
  {
    type: "compaction",
    compact_threshold: compactThreshold,
  },
]

export const applyResponsesApiContextManagement = (
  payload: ResponsesPayload,
  maxPromptTokens?: number,
): void => {
  if (payload.context_management !== undefined) {
    return
  }

  if (
    !responsesUtilsDependencies.isResponsesApiContextManagementModel(
      payload.model,
    )
  ) {
    return
  }

  payload.context_management = createCompactionContextManagement(
    resolveResponsesCompactThreshold(maxPromptTokens),
  )
}

export const compactInputByLatestCompaction = (
  payload: ResponsesPayload,
): void => {
  if (!Array.isArray(payload.input) || payload.input.length === 0) {
    return
  }

  const latestCompactionMessageIndex = getLatestCompactionMessageIndex(
    payload.input,
  )

  if (latestCompactionMessageIndex === undefined) {
    return
  }

  payload.input = payload.input.slice(latestCompactionMessageIndex)
}

const getLatestCompactionMessageIndex = (
  input: Array<ResponseInputItem>,
): number | undefined => {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isCompactionInputItem(input[index])) {
      return index
    }
  }

  return undefined
}

const isCompactionInputItem = (value: ResponseInputItem): boolean => {
  return (
    "type" in value
    && typeof value.type === "string"
    && value.type === "compaction"
  )
}

const getPayloadItems = (
  payload: ResponsesPayload,
): Array<ResponseInputItem> => {
  const result: Array<ResponseInputItem> = []

  const { input } = payload

  if (Array.isArray(input)) {
    result.push(...input)
  }

  return result
}

export const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

type StreamChunk = {
  id?: string
  event?: string
  data?: string
}

export function getStreamChunkFields(chunk: unknown): StreamChunk {
  const c = chunk as StreamChunk
  return {
    id: c.id,
    event: c.event,
    data: c.data,
  }
}

export const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined

  if (type === "input_image") {
    return true
  }

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  return false
}
