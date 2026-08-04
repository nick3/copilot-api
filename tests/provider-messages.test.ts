import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { UsageTokens } from "../src/lib/token-usage"

const actualConfigModule = await import("../src/lib/config")
const actualTokenUsageModule = await import("../src/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null
let claudeAutoModel: string | undefined
let upstreamResponseFactory: () => Response

const recordedUsages: Array<UsageTokens> = []
const providerTokenUsageRecorder = (usage: UsageTokens): void => {
  recordedUsages.push(usage)
}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getClaudeAutoModel: () => claudeAutoModel,
  getProviderConfig: () => providerConfig,
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => providerTokenUsageRecorder,
}))

const { providerMessageRoutes } =
  await import("../src/routes/provider/messages/route")

const originalFetch = globalThis.fetch
const fetchMock = mock((...args: Parameters<typeof fetch>) => {
  void args
  return Promise.resolve(upstreamResponseFactory())
})

const createApp = () => {
  const app = new Hono()
  app.route("/:provider/v1/messages", providerMessageRoutes)
  return app
}

const createProviderConfig = (name = "openrouter"): ResolvedProviderConfig => ({
  apiKey: "provider-key",
  authType: "authorization",
  baseUrl: "https://openrouter.example/api",
  models: {
    "claude-sonnet-4": {},
  },
  name,
  type: "anthropic",
})

const createMessagesPayload = (overrides: Record<string, unknown> = {}) => ({
  max_tokens: 128,
  messages: [{ content: "hello", role: "user" }],
  model: "claude-sonnet-4",
  ...overrides,
})

const createThinkingResponse = () => ({
  content: [
    {
      thinking: "internal reasoning",
      type: "thinking",
    },
    {
      signature: "upstream-signature",
      thinking: "already signed reasoning",
      type: "thinking",
    },
    {
      text: "answer text",
      type: "text",
    },
  ],
  id: "msg_openrouter",
  model: "claude-sonnet-4",
  role: "assistant",
  stop_reason: "end_turn",
  stop_sequence: null,
  type: "message",
  usage: {
    input_tokens: 4,
    output_tokens: 3,
  },
})

const createThinkingStreamResponse = (
  signature?: string,
  cost?: number,
): Response => {
  const chunks: Array<string> = []
  const appendEvent = (event: string, data: unknown): void => {
    chunks.push(`event: ${event}`)
    chunks.push(
      `data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
    )
    chunks.push("")
  }

  appendEvent("message_start", {
    message: {
      content: [],
      id: "msg_openrouter_stream",
      model: "claude-sonnet-4",
      role: "assistant",
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 4, output_tokens: 0 },
    },
    type: "message_start",
  })
  appendEvent("content_block_start", {
    content_block: { thinking: "", type: "thinking" },
    index: 0,
    type: "content_block_start",
  })
  appendEvent("content_block_delta", {
    delta: { thinking: "internal reasoning", type: "thinking_delta" },
    index: 0,
    type: "content_block_delta",
  })
  if (signature !== undefined) {
    appendEvent("content_block_delta", {
      delta: { signature, type: "signature_delta" },
      index: 0,
      type: "content_block_delta",
    })
  }
  appendEvent("content_block_stop", {
    index: 0,
    type: "content_block_stop",
  })
  appendEvent("content_block_start", {
    content_block: { text: "", type: "text" },
    index: 1,
    type: "content_block_start",
  })
  appendEvent("content_block_stop", {
    index: 1,
    type: "content_block_stop",
  })
  appendEvent("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    type: "message_delta",
    usage: { output_tokens: 3, ...(cost === undefined ? {} : { cost }) },
  })
  appendEvent("message_stop", { type: "message_stop" })
  appendEvent("message_stop", "[DONE]")

  return new Response(chunks.join("\n"), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

const parseStreamData = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
    )

beforeEach(() => {
  claudeAutoModel = undefined
  providerConfig = createProviderConfig()
  recordedUsages.length = 0
  upstreamResponseFactory = () =>
    new Response(JSON.stringify(createThinkingResponse()), {
      headers: { "content-type": "application/json" },
    })
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
  claudeAutoModel = undefined
})

describe("provider Messages Anthropic forwarding", () => {
  test("routes Claude security-monitor requests to the configured auto model", async () => {
    claudeAutoModel = "security-monitor-model"

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(
        createMessagesPayload({
          stop_sequences: ["</block>"],
          system:
            "You are a security monitor for autonomous AI coding agents. Inspect the action.",
        }),
      ),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0]?.[1]
    expect(
      typeof init?.body === "string" ? JSON.parse(init.body) : null,
    ).toMatchObject({
      model: "security-monitor-model",
    })
  })

  test("adds an empty thinking signature for OpenRouter JSON responses", async () => {
    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload()),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      content: Array<Record<string, unknown>>
    }
    expect(json.content).toEqual([
      {
        signature: "",
        thinking: "internal reasoning",
        type: "thinking",
      },
      {
        signature: "upstream-signature",
        thinking: "already signed reasoning",
        type: "thinking",
      },
      {
        text: "answer text",
        type: "text",
      },
    ])
  })

  test("adds an empty signature_delta before an unsigned thinking block stops", async () => {
    upstreamResponseFactory = () => createThinkingStreamResponse()

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const events = parseStreamData(await response.text())
    const signatureIndex = events.findIndex(
      (event) =>
        event.type === "content_block_delta"
        && (event.delta as { type?: string } | undefined)?.type
          === "signature_delta",
    )
    const stopIndex = events.findIndex(
      (event) => event.type === "content_block_stop",
    )

    expect(signatureIndex).toBeGreaterThan(-1)
    expect(signatureIndex).toBeLessThan(stopIndex)
    expect(events[signatureIndex]).toEqual({
      delta: { signature: "", type: "signature_delta" },
      index: 0,
      type: "content_block_delta",
    })
  })

  test("preserves an existing OpenRouter streaming signature", async () => {
    upstreamResponseFactory = () => createThinkingStreamResponse("signed")

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const events = parseStreamData(await response.text())
    const signatureEvents = events.filter(
      (event) =>
        event.type === "content_block_delta"
        && (event.delta as { type?: string } | undefined)?.type
          === "signature_delta",
    )
    expect(signatureEvents).toEqual([
      {
        delta: { signature: "signed", type: "signature_delta" },
        index: 0,
        type: "content_block_delta",
      },
    ])
  })

  test("records the cost reported in an OpenRouter message delta", async () => {
    const cost = 0.0002928408
    upstreamResponseFactory = () =>
      createThinkingStreamResponse(undefined, cost)

    const response = await createApp().request("/openrouter/v1/messages", {
      body: JSON.stringify(createMessagesPayload({ stream: true })),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    await response.text()

    expect(recordedUsages).toHaveLength(1)
    expect(recordedUsages[0]).toMatchObject({
      cost,
      input_tokens: 4,
      output_tokens: 3,
    })
  })
})
