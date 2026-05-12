import { AsyncLocalStorage } from "node:async_hooks"

export interface OutboundHeadersSnapshot {
  xRequestId?: string
  xAgentTaskId?: string
  xInteractionId?: string
  xInteractionType?: string
  openaiIntent?: string
  userAgent?: string
}

export interface RequestContext {
  traceId: string
  startTime: number
  userAgent: string
  sessionAffinity: string | undefined
  parentSessionId: string | undefined
  outboundHeaders?: OutboundHeadersSnapshot
  fetchImpl?: typeof fetch
}

const TRACE_ID_MAX_LENGTH = 64
const TRACE_ID_PATTERN = /^\w[\w.-]*$/

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>()

export const requestContext = {
  getStore: () => asyncLocalStorage.getStore(),
  run: <T>(context: RequestContext, callback: () => T) =>
    asyncLocalStorage.run(context, callback),
}

export function generateTraceId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}

function buildOutboundHeadersSnapshot(
  headers: Record<string, string>,
): OutboundHeadersSnapshot {
  const snapshot: OutboundHeadersSnapshot = {
    xRequestId: undefined,
    xAgentTaskId: undefined,
    xInteractionId: undefined,
    xInteractionType: undefined,
    openaiIntent: undefined,
    userAgent: undefined,
  }

  for (const [name, value] of Object.entries(headers)) {
    switch (name.toLowerCase()) {
      case "x-request-id": {
        snapshot.xRequestId = value
        break
      }
      case "x-agent-task-id": {
        snapshot.xAgentTaskId = value
        break
      }
      case "x-interaction-id": {
        snapshot.xInteractionId = value
        break
      }
      case "x-interaction-type": {
        snapshot.xInteractionType = value
        break
      }
      case "openai-intent": {
        snapshot.openaiIntent = value
        break
      }
      case "user-agent": {
        snapshot.userAgent = value
        break
      }
      default: {
        break
      }
    }
  }

  return snapshot
}

export function captureOutboundHeadersSnapshot(
  headers: Record<string, string>,
): void {
  const store = asyncLocalStorage.getStore()
  if (!store) return

  store.outboundHeaders = buildOutboundHeadersSnapshot(headers)
}

export function getOutboundHeadersSnapshot():
  | OutboundHeadersSnapshot
  | undefined {
  return asyncLocalStorage.getStore()?.outboundHeaders
}

export function consumeOutboundHeadersSnapshot():
  | OutboundHeadersSnapshot
  | undefined {
  const store = asyncLocalStorage.getStore()
  const snapshot = store?.outboundHeaders

  if (store) {
    store.outboundHeaders = undefined
  }

  return snapshot
}

export function resolveTraceId(traceId: string | null | undefined): string {
  const candidate = traceId?.trim()

  if (
    !candidate
    || candidate.length > TRACE_ID_MAX_LENGTH
    || !TRACE_ID_PATTERN.test(candidate)
  ) {
    return generateTraceId()
  }

  return candidate
}
