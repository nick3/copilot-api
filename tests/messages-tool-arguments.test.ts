import { describe, expect, test } from "bun:test"
import type { ServerSentEventMessage } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicTool,
} from "~/routes/messages/anthropic-types"
import {
  MessagesToolArgumentsAdapter,
  MessagesToolArgumentsError,
} from "~/routes/messages/tool-arguments"
import cuaReplSchema from "./fixtures/cua-repl-js-schema.json"

const name = "mcp__cua_repl__js"
const payload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "claude-sonnet-5.5",
  max_tokens: 128,
  messages: [{ role: "user", content: "Use the browser" }],
  tools: [
    {
      name,
      input_schema: cuaReplSchema,
      strict: true,
      cache_control: { type: "ephemeral" },
    },
  ],
  ...overrides,
})
const response = (
  input: Record<string, unknown> = {
    arguments: { completion_summary: "Done" },
  },
): AnthropicResponse => ({
  id: "msg-browser",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5.5",
  content: [
    { type: "text", text: "Checking" },
    { type: "tool_use", id: "call-browser", name, input },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 4 },
})
const start = (
  index = 0,
  toolName = name,
  input: Record<string, unknown> = {},
): AnthropicStreamEventData => ({
  type: "content_block_start",
  index,
  content_block: {
    type: "tool_use",
    id: `call-${index}`,
    name: toolName,
    input,
  },
})
const delta = (
  partialJson: string,
  index = 0,
): Extract<AnthropicStreamEventData, { type: "content_block_delta" }> => ({
  type: "content_block_delta",
  index,
  delta: { type: "input_json_delta", partial_json: partialJson },
})
async function* chunks(
  events: Array<AnthropicStreamEventData>,
): AsyncGenerator<ServerSentEventMessage> {
  await Promise.resolve()
  for (const event of events)
    yield { event: event.type, data: JSON.stringify(event) }
}
async function collect(
  events: Array<AnthropicStreamEventData>,
  adapter = new MessagesToolArgumentsAdapter(payload()),
): Promise<Array<AnthropicStreamEventData>> {
  const results: Array<AnthropicStreamEventData> = []
  for await (const chunk of adapter.decodeStream(chunks(events))) {
    results.push(JSON.parse(chunk.data!) as AnthropicStreamEventData)
  }
  return results
}

describe("native Messages tool arguments", () => {
  test("wraps history without mutating the caller payload or tool metadata", () => {
    const original = payload({
      messages: [
        { role: "user", content: "Use the browser" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking" },
            {
              type: "tool_use",
              id: "call-browser",
              name,
              input: { code: "text(1)" },
            },
            {
              type: "tool_use",
              id: "call-other",
              name: "other",
              input: { value: 1 },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-browser",
              content: "Success",
            },
          ],
        },
      ],
    })
    const snapshot = structuredClone(original)
    const adapter = new MessagesToolArgumentsAdapter(original)
    expect(original).toEqual(snapshot)
    expect(adapter.payload.tools?.[0]).toMatchObject({
      name,
      strict: true,
      cache_control: { type: "ephemeral" },
      input_schema: { properties: { arguments: cuaReplSchema } },
    })
    expect(adapter.payload.messages[1]).toMatchObject({
      content: [
        { type: "text", text: "Checking" },
        { input: { arguments: { code: "text(1)" } } },
        { input: { value: 1 } },
      ],
    })
    expect(adapter.payload.messages[2]).toEqual(original.messages[2])
  })

  test("keeps ordinary and server-side tools unchanged", async () => {
    const original = payload({
      tools: [
        {
          name: "ordinary",
          input_schema: {
            type: "object",
            properties: { arguments: { type: "string" } },
          },
        },
        {
          name: "web_search",
          type: "web_search_20250305",
        } as AnthropicTool,
      ],
    })
    const adapter = new MessagesToolArgumentsAdapter(original)
    expect(adapter.payload).toBe(original)
    const originalResponse = response({ arguments: "ordinary" })
    expect(adapter.decodeResponse(originalResponse)).toBe(originalResponse)
    const event = { event: "ping", data: '{"type":"ping"}', id: "event-1" }
    async function* source() {
      await Promise.resolve()
      yield event
    }
    for await (const actual of adapter.decodeStream(source()))
      expect(actual).toBe(event)
    expect(
      new MessagesToolArgumentsAdapter(payload({ tools: undefined })).payload
        .tools,
    ).toBeUndefined()
  })

  test("decodes only the tools that were wrapped", () => {
    const adapter = new MessagesToolArgumentsAdapter(payload())
    const original = response()
    original.content.push({
      type: "tool_use",
      id: "call-other",
      name: "other",
      input: { arguments: "ordinary" },
    })
    const decoded = adapter.decodeResponse(original)
    expect(decoded.content).toMatchObject([
      { text: "Checking" },
      { input: { completion_summary: "Done" } },
      { input: { arguments: "ordinary" } },
    ])
    expect(original.content[1]).toMatchObject({
      input: { arguments: { completion_summary: "Done" } },
    })
  })

  test.each([
    { code: 'text("中文 😀 \\ {}")' },
    { completion_summary: "Done" },
  ])(
    "decodes fragmented streams and preserves message events",
    async (argumentsValue) => {
      const events = await collect([
        {
          type: "message_start",
          message: {
            ...response(),
            content: [],
            stop_reason: null,
            stop_sequence: null,
          },
        },
        { type: "ping" },
        start(),
        ...Array.from(JSON.stringify({ arguments: argumentsValue }), (char) =>
          delta(char),
        ),
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 4 },
        },
        { type: "message_stop" },
      ])
      expect(
        events.filter((event) => event.type === "content_block_delta"),
      ).toEqual([delta(JSON.stringify(argumentsValue))])
      expect(events.at(-1)?.type).toBe("message_stop")
    },
  )

  test("keeps parallel ordinary arguments incremental and decodes populated initial input", async () => {
    const events = await collect([
      start(),
      start(1, "other"),
      start(2, name, { arguments: { completion_summary: "Initial" } }),
      delta('{"arguments":{"code":'),
      delta('{"value":', 1),
      {
        type: "content_block_delta",
        index: 1,
        delta: { text: "text", type: "text_delta" },
      },
      delta("1}", 1),
      delta('"text(1)"}}'),
      { type: "content_block_stop", index: 1 },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 2 },
      { type: "message_stop" },
    ])
    expect(
      events.filter((event) => event.type === "content_block_delta"),
    ).toEqual([
      delta('{"value":', 1),
      {
        type: "content_block_delta",
        index: 1,
        delta: { text: "text", type: "text_delta" },
      },
      delta("1}", 1),
      delta('{"code":"text(1)"}'),
      delta('{"completion_summary":"Initial"}', 2),
    ])
  })

  test.each([
    '{"arguments":',
    '{"arguments":null}',
    '{"code":"unwrapped"}',
    "",
  ])("rejects invalid wrapped stream input %j", async (json) => {
    const error = await collect([
      start(),
      delta(json),
      { type: "content_block_stop", index: 0 },
    ]).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(MessagesToolArgumentsError)
  })

  test("rejects incomplete streams and preserves upstream error events", async () => {
    const ended = await collect([start(), delta('{"arguments":')]).catch(
      (error: unknown) => error,
    )
    expect(ended).toBeInstanceOf(MessagesToolArgumentsError)
    const stopped = await collect([start(), { type: "message_stop" }]).catch(
      (error: unknown) => error,
    )
    expect(stopped).toBeInstanceOf(MessagesToolArgumentsError)
    const error: AnthropicStreamEventData = {
      type: "error",
      error: { type: "api_error", message: "Upstream failed" },
    }
    const events = await collect([start(), error])
    expect(events.at(-1)).toEqual(error)
  })

  describe("token limit", () => {
    const stop: AnthropicStreamEventData = {
      type: "content_block_stop",
      index: 0,
    }
    const messageDelta = (
      stopReason?: "max_tokens" | "end_turn" | "tool_use",
    ): AnthropicStreamEventData => ({
      type: "message_delta",
      delta: stopReason ? { stop_reason: stopReason } : {},
      usage: { output_tokens: 4 },
    })
    const stopped: AnthropicStreamEventData = { type: "message_stop" }

    test("closes a call whose arguments were cut off after content_block_stop", async () => {
      const events = await collect([
        start(),
        delta('{"arguments":{"code":"par'),
        stop,
        messageDelta("max_tokens"),
        stopped,
      ])
      expect(events).toEqual([
        start(),
        stop,
        messageDelta("max_tokens"),
        stopped,
      ])
    })

    test("closes calls that never stopped before the stop reason arrives", async () => {
      const events = await collect([
        start(1),
        delta('{"arguments":{', 1),
        start(2),
        messageDelta("max_tokens"),
        stopped,
      ])
      expect(events).toEqual([
        start(1),
        start(2),
        { type: "content_block_stop", index: 1 },
        { type: "content_block_stop", index: 2 },
        messageDelta("max_tokens"),
        stopped,
      ])
    })

    test.each(["end_turn", "tool_use"] as const)(
      "still rejects an undecodable call when the stop reason is %s",
      async (stopReason) => {
        const error = await collect([
          start(),
          delta('{"arguments":'),
          stop,
          messageDelta(stopReason),
          stopped,
        ]).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(MessagesToolArgumentsError)
        expect((error as Error).message).toContain(
          "Invalid wrapped arguments JSON",
        )
      },
    )

    test("waits for a stop reason before judging an open call", async () => {
      const events = await collect([
        start(),
        delta('{"arguments":{"code":"x"}}'),
        messageDelta(),
        stop,
      ])
      expect(events).toEqual([
        start(),
        messageDelta(),
        delta('{"code":"x"}'),
        stop,
      ])
    })

    test("keeps an empty call when the limit cut a non-streaming call short", () => {
      const adapter = new MessagesToolArgumentsAdapter(payload())
      const cut = { ...response({}), stop_reason: "max_tokens" as const }
      expect(adapter.decodeResponse(cut).content[1]).toMatchObject({
        type: "tool_use",
        input: {},
      })
      const complete = { ...response(), stop_reason: "max_tokens" as const }
      expect(adapter.decodeResponse(complete).content[1]).toMatchObject({
        input: { completion_summary: "Done" },
      })
    })
  })

  test("returns a 502 for malformed non-streaming input", () => {
    const adapter = new MessagesToolArgumentsAdapter(payload())
    try {
      adapter.decodeResponse(response({ wrong: true }))
      throw new Error("Expected failure")
    } catch (error) {
      expect(error).toBeInstanceOf(MessagesToolArgumentsError)
      if (error instanceof MessagesToolArgumentsError)
        expect(error.response.status).toBe(502)
    }
  })

  test("preserves empty events and cancels its source when the client stops reading", async () => {
    const adapter = new MessagesToolArgumentsAdapter(payload())
    let cancelled = false
    async function* source(): AsyncGenerator<ServerSentEventMessage> {
      await Promise.resolve()
      try {
        yield { data: "" }
        yield { data: "[DONE]" }
        yield { data: JSON.stringify(start()) }
        yield { data: "unread" }
      } finally {
        cancelled = true
      }
    }
    const stream = adapter.decodeStream(source())
    expect((await stream.next()).value).toEqual({ data: "" })
    expect((await stream.next()).value).toEqual({ data: "[DONE]" })
    await stream.next()
    await stream.return(undefined)
    expect(cancelled).toBe(true)
  })
})
