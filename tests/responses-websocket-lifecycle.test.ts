import { afterEach, expect, mock, test } from "bun:test"

type Listener = (event: { data?: unknown }) => void
class TestSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static autoOpen = true
  static frames: Array<string> = []
  static instances: Array<TestSocket> = []
  readyState = 0
  listeners = new Map<string, Set<Listener>>()
  constructor() {
    TestSocket.instances.push(this)
    if (TestSocket.autoOpen)
      queueMicrotask(() => {
        this.readyState = 1
        this.emit("open")
      })
  }
  addEventListener(name: string, fn: Listener) {
    const list = this.listeners.get(name) ?? new Set()
    list.add(fn)
    this.listeners.set(name, list)
  }
  removeEventListener(name: string, fn: Listener) {
    this.listeners.get(name)?.delete(fn)
  }
  emit(name: string, data?: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data })
  }
  send() {
    queueMicrotask(() => {
      for (const frame of TestSocket.frames) this.emit("message", frame)
    })
  }
  close() {
    this.readyState = 3
    this.emit("close")
  }
}
const undici = await import("undici")
await mock.module("undici", () => ({ ...undici, WebSocket: TestSocket }))
const { createPooledWebSocketStream, WebSocketMessageBuffer } =
  await import("~/services/responses-websocket")
let sequence = 0
const options = {
  createChunk: (text: string) => text,
  getTerminalDisposition: (text: string) =>
    text === "done" ? ("reuse" as const) : ("continue" as const),
  maxBufferedBytes: 1024,
  maxBufferedMessages: 4,
  openErrorMessage: "open failed",
  openTimeoutMs: 20,
  poolIdleTimeoutMs: 10000,
  streamErrorMessage: "stream failed",
  streamInactivityTimeoutMs: 20,
  terminalChunkMissingMessage: "missing terminal",
}
const open = (
  overrides: Partial<typeof options> = {},
  onIdleClose?: () => void,
) =>
  createPooledWebSocketStream(
    {
      url: "wss://upstream.example/responses",
      headers: {},
      payload: {},
      poolKey: `lifecycle-${sequence++}`,
      onIdleClose,
    },
    { ...options, ...overrides },
  )[Symbol.asyncIterator]()
afterEach(() => {
  for (const socket of TestSocket.instances) socket.close()
  TestSocket.autoOpen = true
  TestSocket.frames = []
  TestSocket.instances = []
})

test("websocket open and inactivity deadlines release unusable sockets", async () => {
  TestSocket.autoOpen = false
  await assertRejects(open().next(), "did not open")
  expect(TestSocket.instances[0].readyState).toBe(3)
  TestSocket.autoOpen = true
  await assertRejects(open().next(), "inactive")
  expect(TestSocket.instances[1].readyState).toBe(3)
})

test("a burst exceeding either buffer limit is terminated", async () => {
  TestSocket.frames = ["x".repeat(30)]
  await assertRejects(open({ maxBufferedBytes: 10 }).next(), "buffer exceeded")
  TestSocket.frames = ["one", "two", "three"]
  const stream = open({ maxBufferedMessages: 1 })
  const consume = async () => {
    while (!(await stream.next()).done) {
      /* drain */
    }
  }
  await assertRejects(consume(), "buffer exceeded")
})

test("early iterator return closes active connections without calling idle bridge cleanup", async () => {
  TestSocket.frames = ["first"]
  const idleClose = mock(() => {})
  const stream = open({}, idleClose)
  expect((await stream.next()).value).toBe("first")
  await stream.return?.()
  expect(TestSocket.instances[0].readyState).toBe(3)
  expect(idleClose).not.toHaveBeenCalled()
})

test("unsolicited data after a terminal event invalidates an idle bridge", async () => {
  TestSocket.frames = ["done"]
  const idleClose = mock(() => {})
  const stream = open({}, idleClose)
  expect((await stream.next()).value).toBe("done")
  expect((await stream.next()).done).toBe(true)
  TestSocket.instances[0].emit("message", "unexpected late event")
  expect(idleClose).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(TestSocket.instances[0].readyState).toBe(3)
})

test("message buffer accounts for binary bytes and compacts after consumption", async () => {
  const buffer = new WebSocketMessageBuffer(4096, 500)
  expect(buffer.enqueue(new Uint8Array([65, 66]))).toBe(true)
  expect(buffer.bufferedBytes).toBe(2)
  expect(await buffer.dequeue()).toBe("AB")
  for (let index = 0; index < 300; index++)
    expect(buffer.enqueue("a")).toBe(true)
  for (let index = 0; index < 300; index++)
    expect(await buffer.dequeue()).toBe("a")
  expect(buffer.bufferedMessages).toBe(0)
  expect(buffer.bufferedBytes).toBe(0)
  expect(buffer.dequeue()).toBeUndefined()
  buffer.enqueue("next")
  buffer.clear()
  expect(buffer.bufferedBytes).toBe(0)
})

test("cancellation while opening prevents dispatch without cancelling later active requests", async () => {
  TestSocket.autoOpen = false
  const client = new AbortController()
  const stream = createPooledWebSocketStream(
    {
      url: "wss://upstream.example",
      headers: {},
      payload: {},
      poolKey: `preflight-${sequence++}`,
      clientSignal: client.signal,
    },
    options,
  )[Symbol.asyncIterator]()
  const next = stream.next()
  const socket = TestSocket.instances[0]
  const send = mock(() => {})
  socket.send = send
  client.abort(new Error("cancelled before dispatch"))
  socket.readyState = TestSocket.OPEN
  socket.emit("open")
  await assertRejects(next, "cancelled before dispatch")
  expect(send).not.toHaveBeenCalled()
})

async function assertRejects(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
    return
  }
  throw new Error("Expected the upstream operation to reject")
}
