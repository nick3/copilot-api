import type { Context } from "hono"

import { randomUUID } from "node:crypto"

import type {
  AccountSelectionReason,
  SelectAccountForRequestFailureReason,
} from "~/lib/accounts-manager"
import type { AffinityKeySource } from "~/lib/utils"

import { getClientIpInfo, getRequestHistoryStore } from "~/lib/request-history"

export const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
export const GPT_5_4_MODEL_ID = "gpt-5.4"
export const GPT_5_4_CHAT_COMPLETIONS_MESSAGE =
  "Please use `/v1/responses` or `/v1/messages` API"

export type RequestContext = {
  requestId: string
  startedAtMs: number

  method: string
  path: string

  clientIp?: string
  clientIpSource?: string
  userAgent?: string

  userId?: string
  safetyIdentifier?: string
  promptCacheKey?: string
  initiator?: "agent" | "user"
  upstreamRequestId?: string
  upstreamSessionId?: string

  affinityKeyUsed?: string
  affinityKeySource?: AffinityKeySource
  selectionReason?: AccountSelectionReason
  affinityHit?: boolean
  affinityCacheKey?: string
}

export type ChatCompletionsHistoryStore = ReturnType<
  typeof getRequestHistoryStore
>

type RequestLogInsert = Parameters<ChatCompletionsHistoryStore["insert"]>[0]

export function buildRequestContext(c: Context): RequestContext {
  const requestId = randomUUID()
  const startedAtMs = Date.now()

  const method = c.req.raw.method
  const path = new URL(c.req.url, "http://local").pathname

  const { ip: clientIp, source: clientIpSource } = getClientIpInfo(c)
  const userAgent = c.req.header("user-agent") ?? undefined

  return {
    requestId,
    startedAtMs,
    method,
    path,
    clientIp,
    clientIpSource,
    userAgent,
  }
}

export function insertRequestLog(
  store: ChatCompletionsHistoryStore,
  request: RequestContext,
  record: Omit<
    RequestLogInsert,
    | "requestId"
    | "startedAtMs"
    | "method"
    | "path"
    | "clientIp"
    | "clientIpSource"
    | "userAgent"
  >,
): void {
  store.insert({
    requestId: request.requestId,
    startedAtMs: request.startedAtMs,
    method: request.method,
    path: request.path,
    clientIp: request.clientIp,
    clientIpSource: request.clientIpSource,
    userAgent: request.userAgent,
    userId: request.userId,
    safetyIdentifier: request.safetyIdentifier,
    promptCacheKey: request.promptCacheKey,
    initiator: request.initiator,
    upstreamRequestId: request.upstreamRequestId,
    affinityKeyUsed: request.affinityKeyUsed,
    affinityKeySource: request.affinityKeySource,
    selectionReason: request.selectionReason,
    affinityHit: request.affinityHit,
    affinityCacheKey: request.affinityCacheKey,
    ...record,
  })
}

export function recordUnsupportedChatCompletionsModel(
  store: ChatCompletionsHistoryStore,
  params: {
    request: RequestContext
    stream: boolean
    clientModel: string
    upstreamModel?: string
    accountId?: string
    accountType?: string
    costUnits?: number
    premiumRemainingBefore?: number
    premiumRemainingAfter?: number
    premiumUnlimitedBefore?: boolean
    premiumUnlimitedAfter?: boolean
  },
): void {
  const {
    request,
    stream,
    clientModel,
    upstreamModel,
    accountId,
    accountType,
    costUnits,
    premiumRemainingBefore,
    premiumRemainingAfter,
    premiumUnlimitedBefore,
    premiumUnlimitedAfter,
  } = params
  const finishedAtMs = Date.now()
  let premiumRemainingDiff: number | undefined
  if (
    premiumRemainingBefore !== undefined
    && premiumRemainingAfter !== undefined
  ) {
    premiumRemainingDiff = premiumRemainingAfter - premiumRemainingBefore
  }

  insertRequestLog(store, request, {
    finishedAtMs,
    durationMs: finishedAtMs - request.startedAtMs,
    upstreamEndpoint: CHAT_COMPLETIONS_ENDPOINT,
    stream,
    accountId,
    accountType,
    costUnits,
    clientModel,
    upstreamModel,
    premiumRemainingBefore,
    premiumRemainingAfter,
    premiumRemainingDiff,
    premiumUnlimitedBefore,
    premiumUnlimitedAfter,
    httpStatus: 400,
    errorName: "invalid_request_error",
    errorMessage: GPT_5_4_CHAT_COMPLETIONS_MESSAGE,
  })
}

export function unsupportedChatCompletionsModelResponse(c: Context) {
  return c.json(
    {
      error: {
        message: GPT_5_4_CHAT_COMPLETIONS_MESSAGE,
        type: "invalid_request_error",
      },
    },
    400,
  )
}

function getSelectionFailureStatus(
  reason: SelectAccountForRequestFailureReason,
): number {
  if (reason === "MODEL_NOT_SUPPORTED") return 400
  if (reason === "NO_ACCOUNTS") return 503
  return 429
}

export function recordSelectionFailure(
  store: ChatCompletionsHistoryStore,
  params: {
    request: RequestContext
    stream: boolean
    clientModel: string
    reason: SelectAccountForRequestFailureReason
  },
): void {
  const { request, stream, clientModel, reason } = params
  const finishedAtMs = Date.now()

  insertRequestLog(store, request, {
    finishedAtMs,
    durationMs: finishedAtMs - request.startedAtMs,
    upstreamEndpoint: CHAT_COMPLETIONS_ENDPOINT,
    stream,
    clientModel,
    httpStatus: getSelectionFailureStatus(reason),
    selectionFailureReason: reason,
  })
}

export function selectionFailureResponse(
  c: Context,
  params: {
    clientModel: string
    reason: SelectAccountForRequestFailureReason
  },
) {
  const { clientModel, reason } = params

  if (reason === "MODEL_NOT_SUPPORTED") {
    return c.json(
      {
        error: {
          message: `Model "${clientModel}" is not available for any configured account.`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  if (reason === "NO_ACCOUNTS") {
    return c.json(
      {
        error: {
          message:
            "No enabled Copilot accounts are configured. Add or re-enable an account.",
          type: "service_unavailable_error",
        },
      },
      503,
    )
  }

  return c.json(
    {
      error: {
        message:
          "All accounts have exhausted their quota. Please wait for quota refresh or add additional accounts.",
        type: "rate_limit_error",
      },
    },
    429,
  )
}
