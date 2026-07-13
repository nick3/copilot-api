import consola from "consola"
import { events } from "fetch-event-stream"
import { createHash } from "node:crypto"
import { WebSocket } from "undici"

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
import { getProxyEnvDispatcher, getWebSocketProxyUrl } from "~/lib/proxy"
import { captureOutboundHeadersSnapshot } from "~/lib/request-context"
import { resolveEffectiveInitiator } from "~/lib/request-initiator"
import { accountFromState } from "~/lib/state"

import { copilotFetch } from "./copilot-fetch"
import { closeResponsesBridge } from "./responses-bridge-registry"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction
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

export type ToolChoiceOptions = "none" | "auto" | "required"
export type ToolSearchExecution = "client" | "server"

export interface ToolChoiceFunction {
  name: string
  type: "function"
}

export type Tool =
  | FunctionTool
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
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content?: string | Array<ResponseInputContent>
  status?: string
  phase?: "commentary" | "final_answer"
}

export interface ResponseFunctionToolCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
  namespace?: string | null
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output"
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
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
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
  type: "input_text" | "output_text"
  text: string
}

export interface ResponseInputImage {
  type: "input_image"
  image_url?: string | null
  file_id?: string | null
  detail: "low" | "high" | "auto"
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

interface ResponsesRequestOptions {
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

const RESPONSES_WEBSOCKET_IDLE_TIMEOUT_MS = 60_000
const RESPONSES_WEBSOCKET_TEXT_DECODER = new TextDecoder()

export const createResponses = async (
  payload: ResponsesPayload,
  {
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
    )

    if (payload.stream) {
      return stream
    }

    return await consumeResponsesWebSocketStream(stream)
  }

  return await createHttpResponses(payload, headers, ctx, {
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
    },
  )

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
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

type ResponsesWebSocketErrorEvent = Parameters<
  NonNullable<InstanceType<typeof WebSocket>["onerror"]>
>[0]

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
): ResponsesStream => runResponsesWebSocketRequest(request, baseUrl)

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

const responsesWebSocketPool = new Map<string, ResponsesWebSocketEntry>()
const responsesWebSocketActiveRequests = new Map<string, number>()

interface ResponsesWebSocketEntry {
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  requestCount: number
  websocketPromise: Promise<InstanceType<typeof WebSocket>>
  // Bridge socket (WS #1) that originated this upstream connection, if any. When
  // this entry is dropped while no turn is in flight, we close that bridge socket
  // so Codex rebuilds a fresh full-context session instead of stalling on a stale
  // `previous_response_id`.
  bridgeId?: string
}

interface ResponsesWebSocketRequestTarget {
  entry: ResponsesWebSocketEntry
  pooled: boolean
}

const runResponsesWebSocketRequest = async function* (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
): ResponsesStream {
  const { entry, pooled } = getResponsesWebSocketRequestTarget(request, baseUrl)
  const release = acquireResponsesWebSocketEntry(request.poolKey, entry, pooled)

  try {
    const websocket = await getReadyResponsesWebSocket(
      request.poolKey,
      entry,
      pooled,
    )
    websocket.send(JSON.stringify(request.payload))

    for await (const data of createWebSocketMessageStream(websocket)) {
      const chunk = createResponsesWebSocketStreamChunk(data)
      yield chunk

      if (isTerminalResponsesStreamChunk(chunk)) {
        return
      }
    }

    removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    throw new Error("Responses websocket ended without a terminal response")
  } catch (error) {
    removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    throw toError(error)
  } finally {
    release()
  }
}

const getResponsesWebSocketRequestTarget = (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
): ResponsesWebSocketRequestTarget => {
  if (getResponsesWebSocketActiveRequestCount(request.poolKey) > 0) {
    return {
      entry: createResponsesWebSocketEntry(request, baseUrl),
      pooled: false,
    }
  }

  const existing = responsesWebSocketPool.get(request.poolKey)
  if (existing && !existing.closed) {
    clearResponsesWebSocketIdleTimer(existing)
    // A Codex client can reconnect for the same session (minting a fresh bridge,
    // hence a fresh bridgeId) before this pooled upstream entry is reaped. Rebind
    // the entry to the currently connected bridge so a later idle reap closes the
    // live WS #1, not the original now-unregistered one — otherwise the multi-turn
    // recovery would target a dead bridge and the next turn could still stall on a
    // stale `previous_response_id`.
    existing.bridgeId = request.bridgeId
    return {
      entry: existing,
      pooled: true,
    }
  }

  const entry = createResponsesWebSocketEntry(request, baseUrl)
  responsesWebSocketPool.set(request.poolKey, entry)
  return {
    entry,
    pooled: true,
  }
}

const createResponsesWebSocketEntry = (
  request: ResponsesWebSocketRequest,
  baseUrl: string,
): ResponsesWebSocketEntry => {
  const entry: ResponsesWebSocketEntry = {
    closed: false,
    idleTimer: null,
    requestCount: 0,
    websocketPromise: openResponsesWebSocket({
      headers: request.headers,
      url: buildResponsesWebSocketUrl(baseUrl),
    }),
    bridgeId: request.bridgeId,
  }

  entry.websocketPromise
    .then((websocket) => {
      websocket.addEventListener("close", () => {
        maybeCloseResponsesBridgeForReapedEntry(request.poolKey, entry)
        removeResponsesWebSocketPoolEntry(request.poolKey, entry)
      })
      websocket.addEventListener("error", () => {
        maybeCloseResponsesBridgeForReapedEntry(request.poolKey, entry)
        removeResponsesWebSocketPoolEntry(request.poolKey, entry)
      })
    })
    .catch(() => {
      removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    })

  return entry
}

// Close the originating bridge socket (WS #1) when the upstream connection it was
// keyed to is dropped while the session is idle, so Codex rebuilds a fresh
// full-context request on its next turn instead of stalling ~5 minutes on a stale
// `previous_response_id`.
//
// Gated to fire only for the live pooled entry (`responsesWebSocketPool` still
// points at it) with no in-flight turn (`requestCount === 0`). This excludes:
//   - throwaway non-pooled entries (never in the pool map), whose normal teardown
//     would otherwise close the bridge after a concurrent turn, and
//   - mid-turn upstream drops (`requestCount > 0`), which the active request's
//     existing error path already surfaces to Codex.
const maybeCloseResponsesBridgeForReapedEntry = (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
): void => {
  if (
    entry.bridgeId === undefined
    || entry.requestCount > 0
    || responsesWebSocketPool.get(poolKey) !== entry
  ) {
    return
  }

  closeResponsesBridge(entry.bridgeId)
}

const acquireResponsesWebSocketEntry = (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
  pooled: boolean,
): (() => void) => {
  clearResponsesWebSocketIdleTimer(entry)
  incrementResponsesWebSocketActiveRequestCount(poolKey)
  entry.requestCount += 1

  let released = false
  return () => {
    if (released) {
      return
    }

    released = true
    entry.requestCount -= 1

    decrementResponsesWebSocketActiveRequestCount(poolKey)
    if (entry.closed || entry.requestCount > 0) {
      return
    }

    if (pooled && responsesWebSocketPool.get(poolKey) === entry) {
      scheduleResponsesWebSocketIdleClose(poolKey, entry)
      return
    }

    removeResponsesWebSocketPoolEntry(poolKey, entry)
  }
}

const getReadyResponsesWebSocket = async (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
  pooled: boolean,
): Promise<InstanceType<typeof WebSocket>> => {
  if (entry.closed) {
    throw new Error(
      "Responses websocket became unavailable before the request started",
    )
  }

  const websocket = await entry.websocketPromise
  if (
    entry.closed
    || (pooled && responsesWebSocketPool.get(poolKey) !== entry)
  ) {
    throw new Error(
      "Responses websocket became unavailable before the request started",
    )
  }

  if (websocket.readyState !== WebSocket.OPEN) {
    removeResponsesWebSocketPoolEntry(poolKey, entry)
    throw new Error(
      "Responses websocket became unavailable before the request started",
    )
  }

  return websocket
}

const scheduleResponsesWebSocketIdleClose = (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
): void => {
  clearResponsesWebSocketIdleTimer(entry)
  entry.idleTimer = setTimeout(() => {
    maybeCloseResponsesBridgeForReapedEntry(poolKey, entry)
    removeResponsesWebSocketPoolEntry(poolKey, entry)
  }, RESPONSES_WEBSOCKET_IDLE_TIMEOUT_MS)
  unrefTimer(entry.idleTimer)
}

const clearResponsesWebSocketIdleTimer = (
  entry: ResponsesWebSocketEntry,
): void => {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
}

const getResponsesWebSocketActiveRequestCount = (poolKey: string): number =>
  responsesWebSocketActiveRequests.get(poolKey) ?? 0

const incrementResponsesWebSocketActiveRequestCount = (
  poolKey: string,
): void => {
  responsesWebSocketActiveRequests.set(
    poolKey,
    getResponsesWebSocketActiveRequestCount(poolKey) + 1,
  )
}

const decrementResponsesWebSocketActiveRequestCount = (
  poolKey: string,
): void => {
  const nextCount = getResponsesWebSocketActiveRequestCount(poolKey) - 1
  if (nextCount <= 0) {
    responsesWebSocketActiveRequests.delete(poolKey)
    return
  }

  responsesWebSocketActiveRequests.set(poolKey, nextCount)
}

const removeResponsesWebSocketPoolEntry = (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
): void => {
  if (responsesWebSocketPool.get(poolKey) === entry) {
    responsesWebSocketPool.delete(poolKey)
  }

  if (entry.closed) {
    return
  }

  entry.closed = true
  clearResponsesWebSocketIdleTimer(entry)
  entry.websocketPromise.then(closeResponsesWebSocket).catch(() => {})
}

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (
    typeof timer === "object"
    && "unref" in timer
    && typeof timer.unref === "function"
  ) {
    timer.unref()
  }
}

const createResponsesWebSocketError = (
  message: string,
  event?: Pick<ResponsesWebSocketErrorEvent, "error" | "message">,
): Error => {
  const reason = event?.error ?? event?.message
  if (reason === undefined || reason === "") {
    return new Error(message)
  }

  const cause = toError(reason)
  return new Error(`${message}: ${cause.message}`, { cause })
}

const openResponsesWebSocket = async ({
  headers,
  url,
}: {
  headers: Record<string, string>
  url: string
}): Promise<InstanceType<typeof WebSocket>> =>
  await new Promise((resolve, reject) => {
    const proxy =
      typeof Bun === "undefined" ? undefined : getWebSocketProxyUrl(url)
    const dispatcher =
      typeof Bun === "undefined" ? getProxyEnvDispatcher() : undefined
    const init = {
      headers,
      ...(proxy ? { proxy } : {}),
      ...(dispatcher ? { dispatcher } : {}),
    }
    const websocket = new WebSocket(url, init)

    const cleanup = () => {
      websocket.removeEventListener("open", onOpen)
      websocket.removeEventListener("error", onError)
    }

    const onOpen = () => {
      cleanup()
      resolve(websocket)
    }

    const onError = (event: ResponsesWebSocketErrorEvent) => {
      cleanup()
      reject(
        createResponsesWebSocketError(
          "Failed to create responses websocket",
          event,
        ),
      )
    }

    websocket.addEventListener("open", onOpen)
    websocket.addEventListener("error", onError)
  })

const createWebSocketMessageStream = async function* (
  websocket: InstanceType<typeof WebSocket>,
): AsyncIterable<string> {
  const queue: Array<Promise<string>> = []
  let closed = false
  let error: Error | null = null
  let notify: (() => void) | null = null

  const wake = () => {
    notify?.()
    notify = null
  }

  const onMessage = (event: { data: unknown }) => {
    queue.push(normalizeWebSocketMessageData(event.data))
    wake()
  }

  const onClose = () => {
    closed = true
    wake()
  }

  const onError = (event: ResponsesWebSocketErrorEvent) => {
    error = createResponsesWebSocketError(
      "Responses websocket stream error",
      event,
    )
    wake()
  }

  websocket.addEventListener("message", onMessage)
  websocket.addEventListener("close", onClose)
  websocket.addEventListener("error", onError)

  try {
    while (true) {
      const item = queue.shift()
      if (item) {
        yield await item
        continue
      }

      if (error) {
        throw toError(error)
      }

      if (closed) {
        break
      }

      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }
  } finally {
    websocket.removeEventListener("message", onMessage)
    websocket.removeEventListener("close", onClose)
    websocket.removeEventListener("error", onError)
  }
}

const normalizeWebSocketMessageData = async (
  data: unknown,
): Promise<string> => {
  if (typeof data === "string") {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return RESPONSES_WEBSOCKET_TEXT_DECODER.decode(data)
  }

  if (ArrayBuffer.isView(data)) {
    const view = data
    return RESPONSES_WEBSOCKET_TEXT_DECODER.decode(
      new Uint8Array(
        view.buffer as ArrayBuffer,
        view.byteOffset,
        view.byteLength,
      ),
    )
  }

  if (isTextReadable(data)) {
    return await data.text()
  }

  return String(data)
}

const isTextReadable = (
  value: unknown,
): value is { text: () => Promise<string> } => {
  if (!value || typeof value !== "object" || !("text" in value)) {
    return false
  }

  return typeof (value as { text?: unknown }).text === "function"
}

const toError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value
  }

  return new Error(String(value))
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

const isTerminalResponsesStreamChunk = (chunk: { data?: string }): boolean => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return false
  }

  try {
    const parsed = JSON.parse(chunk.data) as { type?: unknown }
    return (
      parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete"
      || parsed.type === "error"
    )
  } catch {
    return false
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

const closeResponsesWebSocket = (
  websocket: InstanceType<typeof WebSocket>,
): void => {
  if (
    websocket.readyState === WebSocket.CONNECTING
    || websocket.readyState === WebSocket.OPEN
  ) {
    websocket.close()
  }
}
