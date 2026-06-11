import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { AccountContext } from "../src/lib/types/account"
import type { HTTPError } from "../src/lib/error"
import type { ResponsesResult } from "../src/services/copilot/create-responses"

import {
  registerResponsesBridge,
  unregisterResponsesBridge,
} from "../src/services/copilot/responses-bridge-registry"

type ListenerEvent = {
  data?: string
  error?: unknown
  message?: string
}

type Listener = (event: ListenerEvent) => void

const originalClearTimeout = globalThis.clearTimeout
const originalSetTimeout = globalThis.setTimeout

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static autoComplete = true
  static closeAfterComplete = false
  static errorResponse: Record<string, unknown> | null = null
  static failOpen = false
  static failOpenEvent: ListenerEvent | null = null
  static instances: Array<MockWebSocket> = []

  readonly sent: Array<string> = []
  readonly init: { dispatcher?: unknown; headers?: Record<string, string> }
  readonly url: string
  readyState = MockWebSocket.CONNECTING

  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(
    url: string,
    init: { dispatcher?: unknown; headers?: Record<string, string> },
  ) {
    this.init = init
    this.url = url
    MockWebSocket.instances.push(this)
    originalSetTimeout(() => {
      if (MockWebSocket.failOpen) {
        this.readyState = MockWebSocket.CLOSED
        this.emit("error", MockWebSocket.failOpenEvent ?? {})
        return
      }

      this.readyState = MockWebSocket.OPEN
      this.emit("open", {})
    }, 0)
  }

  addEventListener(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  removeEventListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener)
  }

  send(data: string): void {
    this.sent.push(data)

    if (MockWebSocket.autoComplete) {
      originalSetTimeout(() => {
        this.completeLatestResponse()
      }, 0)
    }
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }

    this.readyState = MockWebSocket.CLOSED
    this.emit("close", {})
  }

  emitError(payload: ListenerEvent): void {
    this.emit("error", payload)
  }

  completeLatestResponse(): void {
    const latestSent = this.sent.at(-1)
    if (!latestSent) {
      throw new Error("No websocket request to complete")
    }

    if (MockWebSocket.errorResponse) {
      this.emit("message", {
        data: JSON.stringify(MockWebSocket.errorResponse),
      })
      return
    }

    const parsed = JSON.parse(latestSent) as { model: string }
    this.emit("message", {
      data: JSON.stringify({
        response: createResponsesResult(
          parsed.model,
          `resp-${this.sent.length}`,
        ),
        sequence_number: 1,
        type: "response.completed",
      }),
    })

    if (MockWebSocket.closeAfterComplete) {
      originalSetTimeout(() => {
        this.close()
      }, 0)
    }
  }

  private emit(event: string, payload: ListenerEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload)
    }
  }
}

class MockAgent {
  close(): Promise<void> {
    return Promise.resolve()
  }

  destroy(): void {}
}

class MockProxyAgent extends MockAgent {
  readonly proxyUrl: string

  constructor(proxyUrl: string) {
    super()
    this.proxyUrl = proxyUrl
  }
}

const setGlobalDispatcherMock = mock((_dispatcher: unknown) => {})

await mock.module("undici", () => ({
  Agent: MockAgent,
  ProxyAgent: MockProxyAgent,
  setGlobalDispatcher: setGlobalDispatcherMock,
  WebSocket: MockWebSocket,
}))

const { state } = await import("../src/lib/state")
const { getProxyEnvDispatcher, initProxyFromEnv } =
  await import("../src/lib/proxy")
const { createResponses } =
  await import("../src/services/copilot/create-responses")

const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeVersion: state.vsCodeVersion,
}

const account: AccountContext = {
  accountType: "individual",
  githubToken: "test-github-token",
  copilotApiUrl: "https://api.githubcopilot.com",
  copilotToken: "test-token",
  vsCodeVersion: "1.120.0",
  clientDeviceId: "device-1",
  clientMachineId: "machine-1",
  clientSessionId: "session-1",
}

const createResponsesResult = (
  model: string,
  id = "resp-test",
): ResponsesResult => ({
  created_at: 0,
  error: null,
  id,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

// Bridge ids registered during a test, unregistered in afterEach so the shared
// registry map does not leak closers between tests.
const registeredTestBridges = new Set<string>()

const trackResponsesBridge = (bridgeId: string, closer: () => void): void => {
  registeredTestBridges.add(bridgeId)
  registerResponsesBridge(bridgeId, closer)
}

beforeEach(() => {
  MockWebSocket.autoComplete = true
  MockWebSocket.closeAfterComplete = false
  MockWebSocket.errorResponse = null
  MockWebSocket.failOpen = false
  MockWebSocket.failOpenEvent = null
  MockWebSocket.instances = []
  state.accountType = "individual"
  state.copilotApiUrl = "https://api.githubcopilot.com"
  state.copilotToken = "test-token"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeVersion = "1.120.0"
})

afterEach(() => {
  MockWebSocket.autoComplete = true
  MockWebSocket.closeAfterComplete = false
  MockWebSocket.errorResponse = null
  MockWebSocket.failOpen = false
  MockWebSocket.failOpenEvent = null
  for (const websocket of MockWebSocket.instances) {
    websocket.close()
  }

  for (const bridgeId of registeredTestBridges) {
    unregisterResponsesBridge(bridgeId)
  }
  registeredTestBridges.clear()

  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.copilotToken = originalState.copilotToken
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeVersion = originalState.vsCodeVersion
  ;(
    globalThis as unknown as { clearTimeout: typeof clearTimeout }
  ).clearTimeout = originalClearTimeout
  ;(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
    originalSetTimeout
})

test("Responses websocket pool reuses the same connection for matching pool keys", async () => {
  await collectResponsesStream("request-1")
  await collectResponsesStream("request-1")

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(2)
})

test("Responses websocket open failure includes the underlying reason", async () => {
  MockWebSocket.failOpen = true
  MockWebSocket.failOpenEvent = {
    error: new Error("tls handshake failed"),
  }

  let thrown: unknown = null

  try {
    await collectResponsesStream("request-1")
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe(
    "Failed to create responses websocket: tls handshake failed",
  )
})

test("Responses websocket preserves rich upstream error details", async () => {
  MockWebSocket.errorResponse = {
    code: "rate_limit_exceeded",
    error: {
      code: "rate_limit_exceeded",
      message: "slow down",
      type: "rate_limit_error",
    },
    headers: {
      "retry-after": "3",
      "x-ratelimit-remaining": "0",
    },
    message: "slow down",
    param: null,
    sequence_number: 1,
    status_code: 429,
    type: "error",
  }

  let thrown: unknown = null
  try {
    await createResponses(
      {
        input: "hello",
        model: "gpt-test",
      },
      {
        initiator: "user",
        requestId: "request-error",
        transport: "websocket",
        vision: false,
      },
      account,
    )
  } catch (error) {
    thrown = error
  }

  const httpError = thrown as HTTPError
  expect(httpError.response.status).toBe(429)
  expect(httpError.response.headers.get("retry-after")).toBe("3")
  expect(httpError.response.headers.get("x-ratelimit-remaining")).toBe("0")
  expect(await httpError.response.json()).toEqual({
    error: {
      code: "rate_limit_exceeded",
      message: "slow down",
      type: "rate_limit_error",
    },
  })
})

test("Responses websocket pool separates different request IDs", async () => {
  await collectResponsesStream("request-1")
  await collectResponsesStream("request-2")

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("Responses websocket does not open until the stream is consumed", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
    account,
  )

  expect(MockWebSocket.instances).toHaveLength(0)

  const iterator = (response as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  const firstChunk = iterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await iterator.next()
})

test("Responses websocket delayed concurrent streams still use dedicated connections", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
    account,
  )
  const secondResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
    account,
  )

  expect(MockWebSocket.instances).toHaveLength(0)

  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const secondIterator = (secondResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondChunk = secondIterator.next()

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondChunk
  await secondIterator.next()

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket concurrent request bypasses the pool without closing the previous websocket", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
    account,
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket multiple concurrent requests each use a dedicated connection", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
    account,
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")
  const thirdPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 3
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[2]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[2]?.sent).toHaveLength(1)

  MockWebSocket.instances[2]?.completeLatestResponse()
  await thirdPromise

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket sequential request reuses the pooled connection after concurrent work completes", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
    account,
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()

  const thirdPromise = collectResponsesStream("request-1")
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 2)

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await thirdPromise
})

test("Responses websocket stream failure includes the underlying reason", async () => {
  MockWebSocket.autoComplete = false

  const streamPromise = collectResponsesStream("request-1")
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.emitError({
    error: new Error("socket hang up"),
  })

  let thrown: unknown = null

  try {
    await streamPromise
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe(
    "Responses websocket stream error: socket hang up",
  )
})

test("Responses websocket uses the proxy-env dispatcher when initialized", async () => {
  const originalHttpProxy = process.env.HTTP_PROXY
  process.env.HTTP_PROXY = "http://127.0.0.1:8080"

  try {
    initProxyFromEnv()
    const dispatcher = getProxyEnvDispatcher()

    await collectResponsesStream("proxy-request")

    expect(dispatcher).toBeDefined()
    expect(MockWebSocket.instances[0]?.init.dispatcher).toBe(dispatcher)
  } finally {
    if (originalHttpProxy === undefined) {
      delete process.env.HTTP_PROXY
    } else {
      process.env.HTTP_PROXY = originalHttpProxy
    }
  }
})

test("closes the originating bridge when its pooled upstream connection drops while idle", async () => {
  let bridgeClosed = 0
  trackResponsesBridge("bridge-idle", () => {
    bridgeClosed += 1
  })

  // Complete a turn so the entry returns to the pool with requestCount === 0.
  await collectResponsesStreamWithBridge("request-1", "bridge-idle")

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(bridgeClosed).toBe(0)

  // The upstream connection being reaped/dropped while idle must close the
  // originating bridge socket so Codex rebuilds a fresh full-context session.
  MockWebSocket.instances[0]?.close()

  expect(bridgeClosed).toBe(1)
})

test("leaves the bridge open when the upstream connection drops mid-turn", async () => {
  MockWebSocket.autoComplete = false
  let bridgeClosed = 0
  trackResponsesBridge("bridge-midturn", () => {
    bridgeClosed += 1
  })

  const streamPromise = collectResponsesStreamWithBridge(
    "request-1",
    "bridge-midturn",
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  // Drop the socket while the turn is still in flight (requestCount > 0). The
  // active request's own error path surfaces this to Codex, so the bridge must
  // NOT be force-closed here.
  MockWebSocket.instances[0]?.emitError({
    error: new Error("socket hang up"),
  })

  await streamPromise.catch(() => {})

  expect(bridgeClosed).toBe(0)
})

test("does not close the bridge for a throwaway concurrent (non-pooled) connection", async () => {
  MockWebSocket.autoComplete = false
  let keptBridgeClosed = 0
  let throwawayBridgeClosed = 0
  trackResponsesBridge("bridge-keep", () => {
    keptBridgeClosed += 1
  })
  trackResponsesBridge("bridge-throwaway", () => {
    throwawayBridgeClosed += 1
  })

  // First request owns the pooled entry for this pool key.
  const firstIterator = await openResponsesStreamWithBridge(
    "request-1",
    "bridge-keep",
  )
  const firstChunk = firstIterator.next()
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  // Concurrent request with the same pool key bypasses the pool and gets a
  // dedicated, non-pooled connection.
  const secondPromise = collectResponsesStreamWithBridge(
    "request-1",
    "bridge-throwaway",
  )
  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  // Finish and drop the throwaway connection. It was never the live pooled
  // entry, so its bridge must NOT be closed.
  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise
  MockWebSocket.instances[1]?.close()

  expect(throwawayBridgeClosed).toBe(0)
  expect(keptBridgeClosed).toBe(0)

  // Drain the still-pooled first request.
  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("rebinds a reused pooled entry to the reconnecting bridge so the idle reap closes the live bridge", async () => {
  let oldBridgeClosed = 0
  let newBridgeClosed = 0
  trackResponsesBridge("bridge-old", () => {
    oldBridgeClosed += 1
  })
  trackResponsesBridge("bridge-new", () => {
    newBridgeClosed += 1
  })

  // Turn 1 over the original bridge. The upstream entry returns to the pool with
  // requestCount === 0 and is keyed to "bridge-old".
  await collectResponsesStreamWithBridge("request-1", "bridge-old")

  // Codex reconnects for the same session (a fresh bridge, hence "bridge-new")
  // BEFORE the pooled upstream entry is reaped. The pool reuses the existing
  // connection, so it must be rebound to the currently connected bridge.
  await collectResponsesStreamWithBridge("request-1", "bridge-new")

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(oldBridgeClosed).toBe(0)
  expect(newBridgeClosed).toBe(0)

  // The idle reap now closes the LIVE bridge ("bridge-new"), not the original
  // now-unregistered one. Without the rebind, the reap would target "bridge-old"
  // and leave the connected bridge stalled on a stale previous_response_id.
  MockWebSocket.instances[0]?.close()

  expect(newBridgeClosed).toBe(1)
  expect(oldBridgeClosed).toBe(0)
})

const collectResponsesStream = async (requestId: string): Promise<void> => {
  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId,
      transport: "websocket",
      vision: false,
    },
    account,
  )

  for await (const _chunk of response as AsyncIterable<unknown>) {
    // consume stream
  }
}

const openResponsesStreamWithBridge = async (
  requestId: string,
  bridgeId: string,
): Promise<AsyncIterableIterator<unknown>> => {
  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      bridgeId,
      initiator: "user",
      requestId,
      transport: "websocket",
      vision: false,
    },
    account,
  )

  return (response as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]() as AsyncIterableIterator<unknown>
}

const collectResponsesStreamWithBridge = async (
  requestId: string,
  bridgeId: string,
): Promise<void> => {
  const iterator = await openResponsesStreamWithBridge(requestId, bridgeId)
  let next = await iterator.next()
  while (!next.done) {
    next = await iterator.next()
  }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return
    }

    await new Promise<void>((resolve) => {
      originalSetTimeout(resolve, 0)
    })
  }

  throw new Error("Timed out waiting for condition")
}
