import { expect, test } from "bun:test"

import {
  createResponsesWebSocketHandler,
  handleResponsesWebSocketMessage,
  isResponsesWebSocketUpgrade,
  parseSseRecords,
  type ResponsesWebSocketData,
} from "~/routes/responses/websocket"

type MockWebSocket = {
  data: ResponsesWebSocketData
  sent: Array<string>
  send: (message: string) => number
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function createMockWebSocket(): MockWebSocket {
  const sent: Array<string> = []
  return {
    data: {
      queue: Promise.resolve(),
      controllers: new Set(),
      headers: [],
      url: "http://localhost:4141/v1/responses",
      bridgeId: "test-bridge-id",
    },
    sent,
    send(message: string) {
      sent.push(message)
      return message.length
    },
  }
}

test("detects Responses websocket upgrade requests", () => {
  expect(
    isResponsesWebSocketUpgrade(
      new Request("http://localhost:4141/v1/responses", {
        headers: {
          upgrade: "websocket",
        },
      }),
    ),
  ).toBe(true)

  expect(
    isResponsesWebSocketUpgrade(
      new Request("http://localhost:4141/responses", {
        headers: {
          upgrade: "WebSocket",
        },
      }),
    ),
  ).toBe(true)

  expect(
    isResponsesWebSocketUpgrade(
      new Request("http://localhost:4141/v1/models", {
        headers: {
          upgrade: "websocket",
        },
      }),
    ),
  ).toBe(false)
})

test("does not treat normal Responses HTTP requests as websocket upgrades", () => {
  expect(
    isResponsesWebSocketUpgrade(
      new Request("http://localhost:4141/v1/responses", {
        method: "POST",
      }),
    ),
  ).toBe(false)
})

test("parses SSE records into websocket payloads", () => {
  const parsed = parseSseRecords(
    'event: response.created\ndata: {"type":"response.created"}\n\n'
      + 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
  )

  expect(parsed).toEqual({
    events: ['{"type":"response.created"}', '{"type":"response.completed"}'],
    remainder: "",
  })
})

test("keeps incomplete SSE records as remainder", () => {
  const parsed = parseSseRecords(
    'event: response.created\ndata: {"type":"response.created"}\n\nevent:',
  )

  expect(parsed).toEqual({
    events: ['{"type":"response.created"}'],
    remainder: "event:",
  })
})

test("ignores SSE done markers", () => {
  expect(parseSseRecords("data: [DONE]\n\n")).toEqual({
    events: [],
    remainder: "",
  })
})

test("responds to websocket warmup without calling app fetch", async () => {
  const ws = createMockWebSocket()
  let fetchCalled = false

  await handleResponsesWebSocketMessage(
    ws as never,
    JSON.stringify({
      generate: false,
      model: "gpt-test",
      type: "response.create",
    }),
    () => {
      fetchCalled = true
      return Promise.resolve(new Response(null, { status: 500 }))
    },
  )

  expect(fetchCalled).toBe(false)
  expect(ws.sent.map((item) => JSON.parse(item) as unknown)).toEqual([
    {
      response: {
        id: "",
      },
      sequence_number: 0,
      type: "response.completed",
    },
  ])
})

test("forwards response.create to app fetch and relays SSE events", async () => {
  const ws = createMockWebSocket()
  let requestBody: unknown

  await handleResponsesWebSocketMessage(
    ws as never,
    JSON.stringify({
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    }),
    async (request) => {
      requestBody = await request.json()
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1"}}\n\n',
        {
          headers: {
            "content-type": "text/event-stream",
          },
        },
      )
    },
  )

  expect(requestBody).toEqual({
    input: "hello",
    model: "gpt-test",
    stream: true,
  })
  expect(ws.sent).toEqual([
    '{"type":"response.completed","response":{"id":"resp-1"}}',
  ])
})

test("forwards the bridge id so the upstream pool can reap the right socket", async () => {
  const ws = createMockWebSocket()
  let capturedRequest: Request | undefined

  await handleResponsesWebSocketMessage(
    ws as never,
    JSON.stringify({
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    }),
    (request) => {
      capturedRequest = request
      return Promise.resolve(
        new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    },
  )

  expect(capturedRequest?.headers.get("x-responses-bridge-id")).toBe(
    "test-bridge-id",
  )
})

test("preserves a single leading space in SSE data per spec", () => {
  expect(parseSseRecords('data:  {"value":"x"}\n\n')).toEqual({
    events: [' {"value":"x"}'],
    remainder: "",
  })
})

test("emits a spec-shaped error frame for invalid JSON", async () => {
  const ws = createMockWebSocket()

  await handleResponsesWebSocketMessage(ws as never, "{not valid", () =>
    Promise.resolve(new Response(null, { status: 500 })),
  )

  expect(ws.sent.map((item) => JSON.parse(item) as unknown)).toEqual([
    {
      code: "400",
      message: "Invalid websocket JSON frame",
      param: null,
      sequence_number: 0,
      type: "error",
    },
  ])
})

test("relays upstream errors as spec-shaped error frames", async () => {
  const ws = createMockWebSocket()

  await handleResponsesWebSocketMessage(
    ws as never,
    JSON.stringify({ input: "hi", model: "gpt-test", type: "response.create" }),
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      ),
  )

  expect(JSON.parse(ws.sent[0]) as unknown).toEqual({
    code: "429",
    message: "boom",
    param: null,
    sequence_number: 0,
    type: "error",
  })
})

test("serializes pipelined response.create frames instead of rejecting them", async () => {
  // Reproduces the codex multi-turn bug: codex reuses one websocket and can
  // send turn 2's `response.create` before turn 1's SSE relay has finished.
  // The bridge must queue turn 2 (not reject it with a 409) and forward both.
  const ws = createMockWebSocket()
  const fetchOrder: Array<string> = []
  let releaseTurnOne: (() => void) | undefined
  const turnOneFetchStarted = createDeferred()

  const handler = createResponsesWebSocketHandler(() => {
    const order = fetchOrder.length
    fetchOrder.push(`fetch-${order}`)

    if (order === 0) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseTurnOne = () => {
            controller.enqueue(
              new TextEncoder().encode(
                'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1"}}\n\n',
              ),
            )
            controller.close()
          }
        },
      })
      turnOneFetchStarted.resolve()
      return Promise.resolve(
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }

    return Promise.resolve(
      new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-2"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  })

  const turnOne = handler.message(
    ws as never,
    JSON.stringify({
      input: "one",
      model: "gpt-test",
      type: "response.create",
    }),
  )
  const turnTwo = handler.message(
    ws as never,
    JSON.stringify({
      input: "two",
      model: "gpt-test",
      previous_response_id: "resp-1",
      type: "response.create",
    }),
  )

  // Turn 2 must wait: only turn 1 has reached the upstream fetch so far.
  await turnOneFetchStarted.promise
  expect(fetchOrder).toEqual(["fetch-0"])

  releaseTurnOne?.()
  await Promise.all([turnOne, turnTwo])

  expect(fetchOrder).toEqual(["fetch-0", "fetch-1"])
  expect(ws.sent).toEqual([
    '{"type":"response.completed","response":{"id":"resp-1"}}',
    '{"type":"response.completed","response":{"id":"resp-2"}}',
  ])
})

test("aborts the upstream stream when the client disconnects", async () => {
  const ws = createMockWebSocket()
  let cancelled = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'event: response.created\ndata: {"type":"response.created"}\n\n',
        ),
      )
    },
    // Never resolves on its own; only torn down via cancel().
    pull() {
      return new Promise<void>(() => {})
    },
    cancel() {
      cancelled = true
    },
  })

  const handler = createResponsesWebSocketHandler(() =>
    Promise.resolve(
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  )

  // Resolve once the bridge relays its first SSE event to the client, so we wait
  // on the real signal instead of a fixed delay.
  const firstEventSent = createDeferred()
  const originalSend = ws.send.bind(ws)
  let sendCount = 0
  ws.send = (message: string) => {
    const result = originalSend(message)
    sendCount += 1
    if (sendCount === 1) {
      firstEventSent.resolve()
    }
    return result
  }

  const messagePromise = handler.message(
    ws as never,
    JSON.stringify({ input: "hi", model: "gpt-test", type: "response.create" }),
  )

  // Let the first SSE event flow through before disconnecting.
  await firstEventSent.promise
  expect(ws.sent).toContain('{"type":"response.created"}')
  expect(ws.data.controllers.size).toBe(1)

  // Simulate the client closing the websocket.
  void handler.close?.(ws as never, 1000, "client closed")
  await messagePromise

  expect(cancelled).toBe(true)
  expect(ws.data.controllers.size).toBe(0)
})

test("a failed turn does not poison the queue for subsequent turns", async () => {
  // If processing one frame rejects (e.g. `ws.send` throws while the socket is
  // closing), the shared `ws.data.queue` promise must not stay rejected and
  // silently drop every later frame for the lifetime of the connection.
  const ws = createMockWebSocket()
  let fetchCount = 0

  // While turn 1 is processing, every send throws (simulating a socket that is
  // tearing down): the relay send throws AND the fallback error send throws, so
  // processing rejects and would poison `ws.data.queue` without the guard.
  let failSends = true
  ws.send = (message: string) => {
    if (failSends) {
      throw new Error("send failed during teardown")
    }
    ws.sent.push(message)
    return message.length
  }

  const handler = createResponsesWebSocketHandler(() => {
    fetchCount += 1
    const id = fetchCount
    return Promise.resolve(
      new Response(
        `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-${id}"}}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  })

  // Turn 1: every send throws -> processing rejects internally.
  await handler.message(
    ws as never,
    JSON.stringify({
      input: "one",
      model: "gpt-test",
      type: "response.create",
    }),
  )

  // The socket has recovered; turn 2 must still be processed and forwarded.
  failSends = false
  await handler.message(
    ws as never,
    JSON.stringify({
      input: "two",
      model: "gpt-test",
      previous_response_id: "resp-1",
      type: "response.create",
    }),
  )

  expect(fetchCount).toBe(2)
  expect(ws.sent).toContain(
    '{"type":"response.completed","response":{"id":"resp-2"}}',
  )
})
