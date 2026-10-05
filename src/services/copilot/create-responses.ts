import { getResponsesStreamTerminalDisposition } from "~/services/responses-websocket-helpers"
import consola from "consola"
import type { events } from "fetch-event-stream"
import { createHash } from "node:crypto"

import type { ReasoningEffort } from "~/lib/reasoning-effort"
import type { SubagentMarker } from "~/lib/subagent"
import type { AccountContext } from "~/lib/types/account"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  logCopilotQuotaSnapshots,
  logCopilotRateLimits,
  type CopilotQuotaSnapshot,
} from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { getUpstreamTransportConfig } from "~/lib/config"
import { createPooledWebSocketStream } from "~/services/responses-websocket"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { captureOutboundHeadersSnapshot } from "~/lib/request-context"
import { resolveEffectiveInitiator } from "~/lib/request-initiator"
import { accountFromState } from "~/lib/state"

import { copilotFetch } from "./copilot-fetch"
import { closeResponsesBridge } from "./responses-bridge-registry"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  text?: ResponsesTextConfig | null
  client_metadata?: Record<string, string> | null
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction | ToolChoiceCustom
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  metadata?: Metadata | null
  stream?: boolean | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  prompt_cache_retention?: "in_memory" | "24h" | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  reasoning?: Reasoning | null
  context_management?: Array<ResponseContextManagementItem> | null
  include?: Array<ResponseIncludable>
  service_tier?: string | null // NOTE: Unsupported by GitHub Copilot
  [key: string]: unknown
}

export interface ResponsesTextConfig {
  format?: ResponsesTextFormat | null
  verbosity?: "low" | "medium" | "high" | null
  [key: string]: unknown
}

export type ResponsesTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | ResponsesTextFormatJSONSchema

export interface ResponsesTextFormatJSONSchema {
  type: "json_schema"
  name: string
  description?: string | null
  schema: { [key: string]: unknown }
  strict?: boolean | null
  [key: string]: unknown
}

export type ToolChoiceOptions = "none" | "auto" | "required"
export type ToolSearchExecution = "client" | "server"

export interface ToolChoiceFunction {
  name: string
  type: "function"
}

export interface ToolChoiceCustom {
  name: string
  type: "custom"
}

export type Tool =
  | FunctionTool
  | CustomTool
  | ToolSearchTool
  | NamespaceTool
  | Record<string, unknown>

export interface FunctionTool {
  name: string
  parameters: { [key: string]: unknown } | null
  strict: boolean | null
  type: "function"
  description?: string | null
  defer_loading?: boolean | null
}

export interface CustomTool {
  type: "custom"
  name: string
  description?: string | null
  format?:
    | { type: "text" }
    | { type: "grammar"; syntax: "lark" | "regex"; definition: string }
    | null
}

export interface ToolSearchTool {
  type: "tool_search"
  execution?: ToolSearchExecution | null
  description?: string | null
  parameters?: { [key: string]: unknown } | null
}

export interface NamespaceTool {
  type: "namespace"
  name: string
  description?: string | null
  tools: Array<FunctionTool>
}

export type ResponseIncludable =
  | "file_search_call.results"
  | "web_search_call.results"
  | "web_search_call.action.sources"
  | "message.input_image.image_url"
  | "computer_call_output.output.image_url"
  | "reasoning.encrypted_content"
  | "code_interpreter_call.outputs"
  | "message.output_text.logprobs"

export interface Reasoning {
  effort?: ReasoningEffort | null
  summary?: "auto" | "concise" | "detailed" | null
  context?: "auto" | "current_turn" | "all_turns" | null
}

export interface ResponseContextManagementCompactionItem {
  type: "compaction"
  compact_threshold: number
}

export type ResponseContextManagementItem =
  ResponseContextManagementCompactionItem

export interface ResponseInputMessage {
  [key: string]: unknown
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content?: string | Array<ResponseInputContent>
  status?: string
  phase?: "commentary" | "final_answer"
}

export interface ResponseInputAgentMessage {
  [key: string]: unknown
  id?: string
  type: "agent_message"
  author: string
  recipient: string
  content: Array<ResponseInputAgentMessageContent>
}

export type ResponseInputAgentMessageContent =
  | {
      type: "input_text"
      text: string
    }
  | {
      type: "encrypted_content"
      encrypted_content: string
    }

export interface ResponseFunctionToolCallItem {
  [key: string]: unknown
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
  namespace?: string | null
}

export interface ResponseFunctionCallOutputItem {
  [key: string]: unknown
  type: "function_call_output"
  call_id: string
  output: string | Array<ResponseInputContent>
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseCustomToolCallItem {
  [key: string]: unknown
  type: "custom_tool_call"
  call_id: string
  name: string
  input: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseCustomToolCallOutputItem {
  [key: string]: unknown
  type: "custom_tool_call_output"
  call_id: string
  output: string | Array<ResponseInputContent>
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseToolSearchCallItem {
  type: "tool_search_call"
  call_id: string
  arguments: Record<string, unknown> | string
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseToolSearchOutputItem {
  type: "tool_search_output"
  call_id: string
  tools: Array<Tool>
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseInputReasoning {
  id?: string
  type: "reasoning"
  summary: Array<{
    type: "summary_text"
    text: string
  }>
  encrypted_content: string
}

export interface ResponseInputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export interface ResponseInputCompactionTrigger {
  type: "compaction_trigger"
}

export interface ResponseInputAdditionalTools {
  id?: string
  role: "developer"
  tools: Array<Tool>
  type: "additional_tools"
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseInputAgentMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseCustomToolCallItem
  | ResponseCustomToolCallOutputItem
  | ResponseToolSearchCallItem
  | ResponseToolSearchOutputItem
  | ResponseInputReasoning
  | ResponseInputCompaction
  | ResponseInputCompactionTrigger
  | ResponseInputAdditionalTools
  | Record<string, unknown>

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage
  | ResponseInputFile
  | Record<string, unknown>

export interface ResponseInputText {
  [key: string]: unknown
  type: "input_text" | "output_text"
  text: string
}

export interface ResponseInputImage {
  type: "input_image"
  image_url?: string | null
  file_id?: string | null
  detail?: "low" | "high" | "auto"
}

export interface ResponseInputFile {
  type: "input_file"
  file_data?: string | null
  file_id?: string | null
  filename?: string | null
}

export interface ResponsesResult {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponseOutputItem>
  output_text: string
  status: string
  copilot_usage?: CopilotUsage | null
  usage?: ResponseUsage | null
  error: ResponseError | null
  incomplete_details: IncompleteDetails | null
  instructions: string | null
  metadata: Metadata | null
  parallel_tool_calls: boolean
  temperature: number | null
  tool_choice: unknown
  tools: Array<Tool>
  top_p: number | null
}

export interface CopilotUsage {
  total_nano_aiu?: number | null
}

export type Metadata = { [key: string]: string }

export interface IncompleteDetails {
  reason?: "max_output_tokens" | "content_filter"
}

export interface ResponseError {
  code?: string | null
  message: string
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputReasoning
  | ResponseOutputFunctionCall
  | ResponseOutputCustomToolCall
  | ResponseOutputToolSearchCall
  | ResponseOutputToolSearchOutput
  | ResponseOutputWebSearchCall
  | ResponseOutputCompaction

export interface ResponseOutputMessage {
  id: string
  type: "message"
  role: "assistant"
  status: "completed" | "in_progress" | "incomplete"
  content?: Array<ResponseOutputContentBlock>
}

export interface ResponseOutputReasoning {
  id: string
  type: "reasoning"
  summary?: Array<ResponseReasoningBlock>
  encrypted_content?: string
  status?: "completed" | "in_progress" | "incomplete"
}

export interface ResponseReasoningBlock {
  type: string
  text?: string
}

export interface ResponseOutputFunctionCall {
  id?: string
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
  namespace?: string | null
}

export interface ResponseOutputCustomToolCall {
  id: string
  type: "custom_tool_call"
  call_id: string
  name: string
  input: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputToolSearchCall {
  id?: string
  type: "tool_search_call"
  call_id: string
  arguments: Record<string, unknown> | string
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputToolSearchOutput {
  id?: string
  type: "tool_search_output"
  call_id: string
  tools: Array<Tool>
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputWebSearchCall {
  id?: string
  type: "web_search_call"
  action?: {
    query?: string
    queries?: Array<string>
    sources?: Array<{ type?: "url"; url: string }>
    type?: string
    url?: string
    pattern?: string
  }
  status?: "in_progress" | "searching" | "completed" | "failed"
}

export interface ResponseOutputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export type ResponseOutputContentBlock =
  | ResponseOutputText
  | ResponseOutputRefusal
  | Record<string, unknown>

export interface ResponseOutputText {
  type: "output_text"
  text: string
  annotations: Array<unknown>
}

export interface ResponseOutputRefusal {
  type: "refusal"
  refusal: string
}

export interface ResponseUsage {
  cost?: number
  input_tokens: number
  output_tokens?: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens: number
    cache_write_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens: number
  }
}

export type ResponseStreamEvent =
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseCustomToolCallInputDeltaEvent
  | ResponseCustomToolCallInputDoneEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseContentPartAddedEvent
  | ResponseOutputTextAnnotationAddedEvent
  | ResponseContentPartDoneEvent
  | ResponseWebSearchCallInProgressEvent
  | ResponseWebSearchCallSearchingEvent
  | ResponseWebSearchCallCompletedEvent
  | ResponseReasoningSummaryPartAddedEvent
  | ResponseReasoningSummaryPartDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent

export interface ResponseCompletedEvent {
  copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
  copilot_usage?: CopilotUsage | null
  response: ResponsesResult
  sequence_number: number
  type: "response.completed"
}

export interface ResponseIncompleteEvent {
  copilot_usage?: CopilotUsage | null
  response: ResponsesResult
  sequence_number: number
  type: "response.incomplete"
}

export interface ResponseCreatedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.created"
}

export interface ResponseInProgressEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.in_progress"
}

export interface ResponseErrorEvent {
  code: string | null
  message: string
  param: string | null
  sequence_number: number
  type: "error"
  error?: {
    type?: string | null
    code: string | null
    message: string
  }
  status_code?: number
  headers?: Record<string, string>
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.delta"
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  arguments: string
  item_id: string
  name: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.done"
}

export interface ResponseCustomToolCallInputDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.custom_tool_call_input.delta"
}

export interface ResponseCustomToolCallInputDoneEvent {
  input: string
  item_id: string
  name: string
  output_index: number
  sequence_number: number
  type: "response.custom_tool_call_input.done"
}

export interface ResponseFailedEvent {
  copilot_usage?: CopilotUsage | null
  response: ResponsesResult
  sequence_number: number
  type: "response.failed"
}

export interface ResponseOutputItemAddedEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.added"
}

export interface ResponseOutputItemDoneEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.done"
}

export interface ResponseContentPartAddedEvent {
  content_index: number
  item_id: string
  output_index: number
  part: ResponseOutputContentBlock
  sequence_number: number
  type: "response.content_part.added"
}

export interface ResponseOutputTextAnnotationAddedEvent {
  annotation: unknown
  annotation_index?: number
  content_index: number
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.output_text.annotation.added"
}

export interface ResponseContentPartDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  part: ResponseOutputContentBlock
  sequence_number: number
  type: "response.content_part.done"
}

export interface ResponseWebSearchCallInProgressEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.in_progress"
}

export interface ResponseWebSearchCallSearchingEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.searching"
}

export interface ResponseWebSearchCallCompletedEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.completed"
}

export interface ResponseReasoningSummaryPartAddedEvent {
  item_id: string
  output_index: number
  part: ResponseReasoningBlock
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_part.added"
}

export interface ResponseReasoningSummaryPartDoneEvent {
  item_id: string
  output_index: number
  part: ResponseReasoningBlock
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_part.done"
}

export interface ResponseReasoningSummaryTextDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_text.delta"
}

export interface ResponseReasoningSummaryTextDoneEvent {
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  text: string
  type: "response.reasoning_summary_text.done"
}

export interface ResponseTextDeltaEvent {
  content_index: number
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.output_text.delta"
}

export interface ResponseTextDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  sequence_number: number
  text: string
  type: "response.output_text.done"
}

export type ResponsesStream = ReturnType<typeof events>
export type CreateResponsesReturn = ResponsesResult | ResponsesStream
export type ResponsesTransport = "http" | "websocket"

export interface ResponsesRequestOptions {
  clientSignal?: AbortSignal
  vision: boolean
  initiator: "agent" | "user"
  upstreamRequestId?: string
  subagentMarker?: SubagentMarker | null
  sessionId?: string
  compactType?: CompactType
  requestId?: string
  fetchImpl?: typeof fetch
  transport?: ResponsesTransport
  bridgeId?: string
}

export const createResponses = async (
  payload: ResponsesPayload,
  {
    clientSignal,
    vision,
    initiator,
    upstreamRequestId,
    subagentMarker,
    sessionId,
    compactType,
    requestId,
    fetchImpl,
    transport = "http",
    bridgeId,
  }: ResponsesRequestOptions,
  account?: AccountContext,
): Promise<CreateResponsesReturn> => {
  clientSignal?.throwIfAborted()
  const ctx = account ?? accountFromState()
  if (!ctx.copilotToken) throw new Error("Copilot token not found")

  const isCompact = Boolean(compactType)
  const effectiveInitiator = resolveEffectiveInitiator(initiator, {
    isCompact,
    isSubagent: Boolean(subagentMarker),
  })

  const headers: Record<string, string> = {
    ...copilotHeaders(ctx, vision, upstreamRequestId),
    "x-initiator": effectiveInitiator,
  }

  prepareInteractionHeaders(sessionId, Boolean(subagentMarker), headers)
  prepareForCompact(headers, compactType)

  payload.service_tier = undefined
  captureOutboundHeadersSnapshot(headers)
  consola.log(`<-- model: ${payload.model}`)

  const effectiveTransport =
    compactType === COMPACT_REQUEST ? "http" : transport

  if (effectiveTransport === "websocket") {
    const websocketRequest = prepareResponsesWebSocketRequest(
      payload,
      headers,
      {
        copilotToken: ctx.copilotToken,
        requestId: requestId ?? upstreamRequestId ?? "missing-request-id",
        sessionId,
        subagentMarker,
        bridgeId,
      },
    )
    const stream = createPooledResponsesWebSocketStream(
      websocketRequest,
      copilotBaseUrl(ctx),
      clientSignal,
    )

    if (payload.stream) {
      return stream
    }

    return await consumeResponsesWebSocketStream(stream)
  }

  return await createHttpResponses(payload, headers, ctx, {
    clientSignal,
    fetchImpl,
    requestId,
  })
}

const createHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  account: AccountContext,
  options: {
    fetchImpl?: typeof fetch
    clientSignal?: AbortSignal
    requestId?: string
  },
): Promise<CreateResponsesReturn> => {
  const response = await copilotFetch(
    `${copilotBaseUrl(account)}/responses`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    {
      requestId: options.requestId,
      callSite: "responses",
      fetchImpl: options.fetchImpl,
      clientSignal: options.clientSignal,
    },
  )

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return createResponsesHttpEventStream(response)
  }

  return (await response.json()) as ResponsesResult
}

type ResponsesWebSocketPayload = ResponsesPayload & {
  type: "response.create"
  initiator: "agent" | "user"
}

interface ResponsesWebSocketRequest {
  headers: Record<string, string>
  poolKey: string
  payload: ResponsesWebSocketPayload
  bridgeId?: string
}

export const prepareResponsesWebSocketRequest = (
  payload: ResponsesPayload,
  preparedHeaders: Record<string, string>,
  options: {
    copilotToken?: string
    requestId: string
    sessionId?: string
    subagentMarker?: SubagentMarker | null
    bridgeId?: string
  },
): ResponsesWebSocketRequest => {
  const initiator = getResponsesWebSocketInitiator(preparedHeaders)

  return {
    headers: copilotWebSocketHeaders(preparedHeaders),
    poolKey: buildResponsesWebSocketPoolKey(payload, options),
    payload: buildResponsesWebSocketPayload(payload, initiator),
    bridgeId: options.bridgeId,
  }
}

export const buildResponsesWebSocketPoolKey = (
  payload: ResponsesPayload,
  {
    copilotToken,
    requestId,
    sessionId,
    subagentMarker,
  }: {
    copilotToken?: string
    requestId: string
    sessionId?: string
    subagentMarker?: SubagentMarker | null
  },
): string => {
  const tokenFingerprint =
    copilotToken ?
      createHash("sha256").update(copilotToken).digest("hex").slice(0, 16)
    : "missing-token"
  const subagentKey =
    subagentMarker ?
      [
        subagentMarker.session_id,
        subagentMarker.agent_id,
        subagentMarker.agent_type,
      ].join(":")
    : "main"

  // Key the upstream websocket on the session, not the per-request id. Copilot
  // stores Responses conversation state (referenced by `previous_response_id`)
  // per upstream connection, so every turn of a session must reuse the same
  // socket. Codex derives a stable `prompt_cache_key` (its thread id) per
  // session, which upstream callers turn into `sessionId`. Fall back to
  // `requestId` when no session id is available (e.g. one-off HTTP callers).
  const connectionAffinityKey = sessionId ?? requestId

  return [tokenFingerprint, payload.model, connectionAffinityKey, subagentKey]
    .map(encodePoolKeyPart)
    .join("|")
}

export const getResponsesWebSocketInitiator = (
  preparedHeaders: Record<string, string>,
): "agent" | "user" => {
  const initiator = getHeaderValue(preparedHeaders, "x-initiator")
  return initiator?.toLowerCase() === "agent" ? "agent" : "user"
}

const createPooledResponsesWebSocketStream = (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
  clientSignal?: AbortSignal,
): ResponsesStream =>
  runResponsesWebSocketRequest(request, baseUrl, clientSignal)

export const buildResponsesWebSocketPayload = (
  payload: ResponsesPayload,
  initiator: "agent" | "user",
): ResponsesWebSocketPayload => {
  const websocketPayload: ResponsesWebSocketPayload = {
    ...payload,
    type: "response.create",
    initiator,
  }

  delete websocketPayload.stream
  delete websocketPayload["background"]
  delete websocketPayload.service_tier

  return websocketPayload
}

export const buildResponsesWebSocketUrl = (baseUrl: string): string => {
  const url = new URL(`${baseUrl.replace(/\/+$/u, "")}/responses`)

  if (url.protocol === "https:") {
    url.protocol = "wss:"
  } else if (url.protocol === "http:") {
    url.protocol = "ws:"
  }

  return url.toString()
}

const getHeaderValue = (
  headers: Record<string, string>,
  headerName: string,
): string | undefined => {
  const normalizedHeaderName = headerName.toLowerCase()
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedHeaderName,
  )

  return match?.[1]
}

const encodePoolKeyPart = (value: string): string => encodeURIComponent(value)

const createResponsesWebSocketStreamChunk = (
  data: string,
): { data?: string; event?: string; id?: string } => {
  if (data === "[DONE]") {
    return { data }
  }

  try {
    const parsed = JSON.parse(data) as {
      copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
      id?: unknown
      type?: unknown
      error?: {
        code: string | null
        message: string
      }
      code?: string | null
      message?: string
    }
    if (parsed.type === "response.completed") {
      logCopilotQuotaSnapshots(parsed.copilot_quota_snapshots)
    }
    if (parsed.type === "error" && parsed.error) {
      consola.warn("Copilot responses websocket stream error:", parsed.error)
      parsed.code = parsed.error.code
      parsed.message = parsed.error.message
    }
    return {
      data: JSON.stringify(parsed),
      event: typeof parsed.type === "string" ? parsed.type : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    }
  } catch {
    return { data }
  }
}

const consumeResponsesWebSocketStream = async (
  stream: ResponsesStream,
): Promise<ResponsesResult> => {
  for await (const chunk of stream) {
    if (!chunk.data || chunk.data === "[DONE]") {
      continue
    }

    const event = JSON.parse(chunk.data) as ResponseStreamEvent
    if (event.type === "error") {
      throw createResponsesWebSocketHttpError(event)
    }

    if (
      event.type === "response.completed"
      || event.type === "response.failed"
      || event.type === "response.incomplete"
    ) {
      return event.response
    }
  }

  throw new Error("Responses websocket ended without a terminal response")
}

const createResponsesWebSocketHttpError = (
  event: ResponseErrorEvent,
): HTTPError => {
  const status = getResponsesWebSocketErrorStatus(event)
  const body = {
    error: event.error ?? { message: event.message },
  }
  return new HTTPError(
    event.message,
    new Response(JSON.stringify(body), {
      headers: event.headers,
      status,
    }),
  )
}

const getResponsesWebSocketErrorStatus = (
  event: ResponseErrorEvent,
): number => {
  const status =
    typeof event.status_code === "number" ? event.status_code
    : typeof event.code === "string" ? parseInt(event.code, 10)
    : NaN

  return Number.isFinite(status) && status >= 100 && status < 600 ? status : 500
}

const runResponsesWebSocketRequest = async function* (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
  clientSignal?: AbortSignal,
): ResponsesStream {
  if (clientSignal?.aborted) return
  const config = getUpstreamTransportConfig()
  yield* createPooledWebSocketStream(
    {
      ...request,
      clientSignal,
      // Namespace the transport pool; the public affinity key remains unchanged.
      poolKey: `copilot|${request.poolKey}`,
      url: buildResponsesWebSocketUrl(baseUrl),
      onIdleClose:
        request.bridgeId ?
          () => closeResponsesBridge(request.bridgeId!)
        : undefined,
    },
    {
      createChunk: createResponsesWebSocketStreamChunk,
      getTerminalDisposition: getResponsesStreamTerminalDisposition,
      maxBufferedBytes: config.websocketMaxBufferedBytes,
      maxBufferedMessages: config.websocketMaxBufferedMessages,
      openTimeoutMs: config.websocketOpenTimeoutMs,
      poolIdleTimeoutMs: config.websocketPoolIdleTimeoutMs,
      streamInactivityTimeoutMs: config.streamInactivityTimeoutMs,
      openErrorMessage: "Failed to create responses websocket",
      streamErrorMessage:
        "Upstream connection lost, responses websocket stream error",
      terminalChunkMissingMessage:
        "Responses websocket ended without a terminal response, retry your request.",
    },
  )
}
