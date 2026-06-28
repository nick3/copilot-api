import type {
  ResponseContextManagementCompactionItem,
  ResponseFunctionCallOutputItem,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
  ResponsesTransport,
} from "~/services/copilot/create-responses"

import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  getModelResponsesApiCompactThreshold as getConfiguredModelResponsesApiCompactThreshold,
  isForceAgentEnabled,
  isResponsesApiContextManagementEnabled as isConfiguredResponsesApiContextManagementEnabled,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"

export const RESPONSES_ENDPOINT = "/responses"
export const RESPONSES_WS_ENDPOINT = "ws:/responses"
export const DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO = 0.9

export const responsesUtilsDependencies = {
  getModelResponsesApiCompactThreshold:
    getConfiguredModelResponsesApiCompactThreshold,
  isResponsesApiContextManagementEnabled:
    isConfiguredResponsesApiContextManagementEnabled,
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

const DATA_URL_PREFIX = "data:"
// Static 96x32 PNG reading "Image too large / Redacted".
const REDACTED_IMAGE_PLACEHOLDER_DATA_URL =
  "data:image/png;base64,"
  + [
    "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAMAAADaHo1mAAADAFBMVEX///8fKTfR1dsAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAACae8QWAAAAvElEQVR42u1WixKAIAhj/f9Hdz2BXJiVed3pVSYtpgwsGSo3GaRq6wSd4F8EyIJx",
    "ydSUAMB8il51sHT2fiVQu8czguQwXWAyFvswIJhmoS9gmzYlcFiHj1aAgzcJVgCyguYhAhNZmMhYQZs1EJnnIAqKiuHjSrZT",
    "ucSQ4s8JkKDDIYr3IuR8vEWgqroKP9b1bYKk2wfgeVmqATQLXdXamsXdEKkz3QXEEeTTuWWImMhW6qci94/+hwSVf99HqVoD",
    "OAuj2SEAAAAASUVORK5CYII=",
  ].join("")

export const sanitizeOversizedInputImages = (
  payload: ResponsesPayload,
  maxPromptImageSize?: number,
): number => {
  const limit =
    typeof maxPromptImageSize === "number" && maxPromptImageSize > 0 ?
      maxPromptImageSize
    : undefined

  if (limit === undefined || !Array.isArray(payload.input)) {
    return 0
  }

  return sanitizeInputImages(
    payload.input,
    (image) => image.decodedBytes > limit,
  )
}

export const sanitizeAllInputImages = (payload: ResponsesPayload): number => {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  return sanitizeInputImages(payload.input, () => true)
}

interface InputImageDataUrl {
  decodedBytes: number
  record: ResponseInputImage
}

const sanitizeInputImages = (
  input: Array<ResponseInputItem>,
  shouldReplace: (image: InputImageDataUrl) => boolean,
): number => {
  let count = 0
  for (const image of collectInputImageDataUrls(input)) {
    if (!shouldReplace(image)) {
      continue
    }

    replaceInputImageWithPlaceholder(image)
    count += 1
  }

  return count
}

const collectInputImageDataUrls = (
  input: Array<ResponseInputItem>,
  images: Array<InputImageDataUrl> = [],
): Array<InputImageDataUrl> => {
  for (const item of input) {
    collectInputItemImageDataUrls(item, images)
  }

  return images
}

const collectInputItemImageDataUrls = (
  item: ResponseInputItem,
  images: Array<InputImageDataUrl>,
): void => {
  if (isResponseInputMessage(item)) {
    collectContentImageDataUrls(item.content, images)
  } else if (isResponseFunctionCallOutputItem(item)) {
    collectContentImageDataUrls(item.output, images)
  }
}

const collectContentImageDataUrls = (
  content: string | Array<ResponseInputContent> | undefined,
  images: Array<InputImageDataUrl>,
): void => {
  if (!Array.isArray(content)) {
    return
  }

  for (const block of content) {
    const image = getInputImageDataUrl(block)
    if (image) {
      images.push(image)
    }
  }
}

const getInputImageDataUrl = (
  content: ResponseInputContent,
): InputImageDataUrl | null => {
  if (!isResponseInputImage(content) || typeof content.image_url !== "string") {
    return null
  }

  const imageUrl = content.image_url
  if (!imageUrl.startsWith(DATA_URL_PREFIX)) {
    return null
  }

  const decodedBytes = estimateDataUrlByteLength(imageUrl)

  return {
    decodedBytes,
    record: content,
  }
}

const estimateDataUrlByteLength = (value: string): number => {
  return Math.max(0, Math.floor((value.length * 3) / 4))
}

const replaceInputImageWithPlaceholder = (image: InputImageDataUrl): void => {
  image.record.type = "input_image"
  image.record.image_url = REDACTED_IMAGE_PLACEHOLDER_DATA_URL
  image.record.detail = "low"
  delete image.record.file_id
}

const isResponseInputMessage = (
  item: ResponseInputItem,
): item is ResponseInputMessage => {
  return (
    typeof item === "object"
    && item !== null
    && "role" in item
    && typeof item.role === "string"
  )
}

const isResponseFunctionCallOutputItem = (
  item: ResponseInputItem,
): item is ResponseFunctionCallOutputItem => {
  return (
    typeof item === "object"
    && item !== null
    && "type" in item
    && item.type === "function_call_output"
  )
}

const isResponseInputImage = (
  content: ResponseInputContent,
): content is ResponseInputImage => {
  return (
    typeof content === "object"
    && content !== null
    && "type" in content
    && content.type === "input_image"
  )
}

export const resolveResponsesCompactThreshold = (
  maxPromptTokens?: number,
  compactThresholdRatio = DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO,
): number => {
  if (typeof maxPromptTokens === "number" && maxPromptTokens > 0) {
    return Math.floor(maxPromptTokens * compactThresholdRatio)
  }

  return 200_000 * compactThresholdRatio
}

const getModelResponsesApiCompactThreshold = (
  model: string,
): number | undefined => {
  const threshold =
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold(model)

  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) {
    return undefined
  }

  return threshold
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
  compactThresholdRatio = DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO,
): void => {
  if (hasTerminalCompactionTrigger(payload)) {
    return
  }

  if (payload.context_management !== undefined) {
    return
  }

  if (!responsesUtilsDependencies.isResponsesApiContextManagementEnabled()) {
    return
  }

  const modelCompactThreshold = getModelResponsesApiCompactThreshold(
    payload.model,
  )
  payload.context_management = createCompactionContextManagement(
    modelCompactThreshold
      ?? resolveResponsesCompactThreshold(
        maxPromptTokens,
        compactThresholdRatio,
      ),
  )
}

const hasTerminalCompactionTrigger = (payload: ResponsesPayload): boolean => {
  const { input } = payload
  if (!Array.isArray(input) || input.length === 0) {
    return false
  }

  return isResponseInputItemType(input.at(-1), "compaction_trigger")
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
  return isResponseInputItemType(value, "compaction")
}

const isResponseInputItemType = (value: unknown, type: string): boolean => {
  return (
    typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === type
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

// Codex (>= v0.142.x) stamps every Responses input item with this field to
// carry a turn id. GitHub Copilot's upstream `/responses` endpoint rejects
// unknown parameters, so the request fails with a `bad_request` error
// ("Unknown parameter: ..."). Strip it from each input item before forwarding
// upstream.
export const INTERNAL_CHAT_METADATA_PASSTHROUGH_KEY =
  "internal_chat_message_metadata_passthrough"

export const stripInternalChatMetadataPassthrough = (
  payload: ResponsesPayload,
): void => {
  if (!Array.isArray(payload.input) || payload.input.length === 0) return

  for (const item of payload.input) {
    if (
      typeof item === "object"
      && item !== null
      && INTERNAL_CHAT_METADATA_PASSTHROUGH_KEY in item
    ) {
      delete item[INTERNAL_CHAT_METADATA_PASSTHROUGH_KEY]
    }
  }
}

type StreamChunk = {
  id?: string
  event?: string
  data?: string | Promise<string>
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
