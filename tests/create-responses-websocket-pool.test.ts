import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { AccountContext } from "../src/lib/types/account"
import type { ResponsesResult } from "../src/services/copilot/create-responses"

type Listener = (event: { data?: string }) => void

const originalClearTimeout = globalThis.clearTimeout
const originalSetTimeout = globalThis.setTimeout

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static autoComplete = true
  static failOpen = false
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
        this.emit("error", {})
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

  completeLatestResponse(): void {
    const latestSent = this.sent.at(-1)
    if (!latestSent) {
      throw new Error("No websocket request to complete")
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
  }

  private emit(event: string, payload: { data?: string }): void {
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

beforeEach(() => {
  MockWebSocket.autoComplete = true
  MockWebSocket.failOpen = false
  MockWebSocket.instances = []
  state.accountType = "individual"
  state.copilotApiUrl = "https://api.githubcopilot.com"
  state.copilotToken = "test-token"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeVersion = "1.120.0"
})

afterEach(() => {
  MockWebSocket.autoComplete = true
  MockWebSocket.failOpen = false
  for (const websocket of MockWebSocket.instances) {
    websocket.close()
  }

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

test("Responses websocket pool separates different request IDs", async () => {
  await collectResponsesStream("request-1")
  await collectResponsesStream("request-2")

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("Responses websocket pool clears stale idle timer after a queued request starts", async () => {
  MockWebSocket.autoComplete = false

  type IdleTimer = ReturnType<typeof setTimeout> & {
    cleared: boolean
    fire: () => void
    unref: () => void
  }
  const idleTimers: Array<IdleTimer> = []

  ;(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    ...args: Parameters<typeof setTimeout>
  ) => {
    const [handler, timeout] = args
    if (timeout === 60_000 && typeof handler === "function") {
      const idleHandler = handler as () => void
      const timer = {
        cleared: false,
        fire: () => {
          if (!timer.cleared) {
            idleHandler()
          }
        },
        unref: () => {},
      } as IdleTimer
      idleTimers.push(timer)
      return timer
    }

    return originalSetTimeout(...args)
  }) as typeof setTimeout
  ;(
    globalThis as unknown as { clearTimeout: typeof clearTimeout }
  ).clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    const idleTimer = idleTimers.find((entry) => entry === timer)
    if (idleTimer) {
      idleTimer.cleared = true
      return
    }

    originalClearTimeout(timer)
  }) as typeof clearTimeout

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
  await waitFor(() => idleTimers.length === 0)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 2)
  expect(idleTimers).toHaveLength(1)
  expect(idleTimers[0]?.cleared).toBe(true)

  idleTimers[0]?.fire()
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await secondPromise
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
