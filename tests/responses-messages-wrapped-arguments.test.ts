import { describe, expect, test } from "bun:test"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js"
import cuaReplSchema from "./fixtures/cua-repl-js-schema.json"

import type {
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/routes/messages/anthropic-types"
import type {
  ResponsesPayload,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import {
  ResponsesMessagesTranslationError,
  translateAnthropicToResponses,
  translateResponsesToMessages,
} from "~/routes/responses/messages-translation"
import { translateMessagesStream } from "~/routes/responses/messages-stream-translation"

// Original schema captured from request_log 852, also present in request 1122.
const browserSchema = cuaReplSchema

const browserTool = {
  type: "function" as const,
  name: "mcp__cua_repl__js",
  description: "Control browser tabs",
  parameters: browserSchema,
}

const translate = (payload: Partial<ResponsesPayload> = {}) =>
  translateResponsesToMessages(
    {
      model: "claude-sonnet-5.5",
      input: "Use the browser",
      tools: [browserTool],
      ...payload,
    },
    { model: "claude-sonnet-5.5" },
  )

const responseWithInput = (
  input: Record<string, unknown>,
): AnthropicResponse => ({
  content: [
    { type: "tool_use", id: "call-browser", name: browserTool.name, input },
  ],
  id: "msg-browser",
  model: "claude-sonnet-5.5",
  role: "assistant",
  stop_reason: "tool_use",
  stop_sequence: null,
  type: "message",
  usage: { input_tokens: 5, output_tokens: 4 },
})

const toolStart = (
  index = 0,
  name = browserTool.name,
  input: Record<string, unknown> = {},
): AnthropicStreamEventData => ({
  type: "content_block_start",
  index,
  content_block: { type: "tool_use", id: `call-${index}`, name, input },
})

const toolDelta = (
  partialJson: string,
  index = 0,
): AnthropicStreamEventData => ({
  type: "content_block_delta",
  index,
  delta: { type: "input_json_delta", partial_json: partialJson },
})

async function* streamChunks(source: Array<AnthropicStreamEventData>) {
  await Promise.resolve()
  yield {
    data: JSON.stringify({
      type: "message_start",
      message: { ...responseWithInput({}), content: [], stop_reason: null },
    }),
  }
  for (const event of source) yield { data: JSON.stringify(event) }
}

const collect = async (
  source: Array<AnthropicStreamEventData>,
  translation = translate({ stream: true }),
): Promise<Array<ResponseStreamEvent>> => {
  const events: Array<ResponseStreamEvent> = []
  for await (const event of translateMessagesStream(
    streamChunks(source),
    translation,
  )) {
    events.push(event)
  }
  return events
}

describe("Messages function argument wrappers", () => {
  test("preserves the browser tool's exclusive parameter branches", () => {
    const original = structuredClone(browserTool)
    const translation = translate()
    const schema = translation.messagesPayload.tools?.[0]?.input_schema
    expect(schema).toEqual({
      type: "object",
      properties: { arguments: browserSchema },
      required: ["arguments"],
      additionalProperties: false,
    })
    expect(translation.messagesPayload.tools?.[0]).toMatchObject({
      name: browserTool.name,
      description: browserTool.description,
    })
    expect(browserTool).toEqual(original)

    const validate = new AjvJsonSchemaValidator().getValidator(schema!)
    for (const argumentsValue of [
      { code: "await tab.getState()", title: "Checking the page" },
      { completion_summary: "Checked the page" },
    ]) {
      expect(validate({ arguments: argumentsValue }).valid).toBe(true)
    }
    for (const input of [
      {},
      { code: "await tab.getState()" },
      { arguments: {} },
      { arguments: { code: "code", completion_summary: "summary" } },
      { arguments: { code: 123 } },
      { arguments: { code: "code", timeout_ms: "wrong" } },
      { arguments: { completion_summary: "Done", title: "extra" } },
      { arguments: { completion_summary: "Done", timeout_ms: 30000 } },
      { arguments: { code: "code", extra: true } },
      { arguments: { code: "code" }, extra: true },
    ]) {
      expect(validate(input).valid).toBe(false)
    }
  })

  test.each(["oneOf", "allOf", "anyOf"])("wraps a top-level %s", (keyword) => {
    const parameters = {
      type: "object",
      [keyword]: [
        { properties: { value: { type: "string" } }, required: ["value"] },
      ],
    }
    const translation = translate({ tools: [{ ...browserTool, parameters }] })
    const schema = translation.messagesPayload.tools?.[0]?.input_schema
    expect(schema).not.toHaveProperty(keyword)
    expect(schema).toHaveProperty(
      `properties.arguments.${keyword}`,
      parameters[keyword],
    )
  })

  test("keeps nested unions and existing arguments properties unwrapped", () => {
    const parameters = {
      type: "object",
      properties: {
        arguments: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    }
    const translation = translate({ tools: [{ ...browserTool, parameters }] })
    expect(translation.messagesPayload.tools?.[0]?.input_schema).toEqual(
      parameters,
    )
    const result = translateAnthropicToResponses(
      responseWithInput({ arguments: "original" }),
      translation,
    )
    expect(result.output[0]).toMatchObject({
      arguments: '{"arguments":"original"}',
    })
  })

  test("preserves the schema dialect at the wrapper root", () => {
    const dialect = "https://json-schema.org/draft/2020-12/schema"
    const translation = translate({
      tools: [
        { ...browserTool, parameters: { $schema: dialect, ...browserSchema } },
      ],
    })
    const schema = translation.messagesPayload.tools?.[0]?.input_schema
    expect(schema).toHaveProperty("$schema", dialect)
    expect(schema).toHaveProperty("properties.arguments", browserSchema)
  })

  test("relocates dynamic JSON Pointers and preserves anchors and external references", () => {
    const parameters = {
      type: "object",
      allOf: [{ properties: { value: { $dynamicRef: "#/$defs/value" } } }],
      $defs: { value: { type: "string", $anchor: "value" } },
      properties: {
        anchored: { $ref: "#value" },
        external: { $ref: "https://example.test/external#/$defs/value" },
        choice: { $ref: "#/$defs/value", const: { $ref: "#/$defs/value" } },
      },
    }
    const schema = translate({ tools: [{ ...browserTool, parameters }] })
      .messagesPayload.tools?.[0]?.input_schema
    expect(schema).toHaveProperty(
      "properties.arguments.allOf.0.properties.value.$dynamicRef",
      "#/properties/arguments/$defs/value",
    )
    expect(schema).toHaveProperty(
      "properties.arguments.properties.anchored.$ref",
      "#value",
    )
    expect(schema).toHaveProperty(
      "properties.arguments.properties.external.$ref",
      parameters.properties.external.$ref,
    )
    expect(schema).toHaveProperty(
      "properties.arguments.properties.choice.const",
      parameters.properties.choice.const,
    )
  })

  test("retains an original arguments property across wrapped response and replay", () => {
    const translation = translate({
      tools: [
        {
          ...browserTool,
          parameters: {
            type: "object",
            allOf: [{ properties: { arguments: { type: "string" } } }],
          },
        },
      ],
    })
    const result = translateAnthropicToResponses(
      responseWithInput({ arguments: { arguments: "original" } }),
      translation,
    )
    const call = result.output[0]
    expect(call).toMatchObject({ arguments: '{"arguments":"original"}' })
    if (call.type !== "function_call") throw new Error("Expected function call")
    const replay = translate({
      tools: translation.originalPayload.tools,
      input: [{ ...call }],
    })
    expect(replay.messagesPayload.messages[0]).toMatchObject({
      content: [{ input: { arguments: { arguments: "original" } } }],
    })
  })

  test("relocates local references without rewriting literal values or separate resources", () => {
    const literal = { $ref: "#/$defs/value" }
    const resource = {
      $id: "https://example.test/child",
      type: "object",
      definitions: { value: { type: "string" } },
      properties: { value: { $ref: "#/definitions/value" } },
    }
    const parameters = {
      type: "object",
      $defs: { value: { type: "string" } },
      definitions: {
        count: { type: "integer" },
        presence: { required: ["value"] },
      },
      properties: {
        value: { $ref: "#/$defs/value", default: literal, examples: [literal] },
        count: { $ref: "#/definitions/count" },
        escaped: { $ref: "#%2F$defs%2Fvalue" },
        child: resource,
        children: { type: "array", items: { $ref: "#" } },
      },
      patternProperties: { "^text": { $ref: "#/$defs/value" } },
      dependencies: { child: { $ref: "#/definitions/presence" }, count: [] },
      dependentSchemas: { value: { $ref: "#/definitions/presence" } },
      oneOf: [{ required: ["value"] }, { required: ["count"] }],
      not: { required: ["forbidden"] },
      additionalProperties: false,
    }
    const original = structuredClone(parameters)
    const translation = translate({ tools: [{ ...browserTool, parameters }] })
    const schema = translation.messagesPayload.tools?.[0]?.input_schema
    expect(schema).toHaveProperty(
      "properties.arguments.properties.value.$ref",
      "#/properties/arguments/$defs/value",
    )
    expect(schema).toHaveProperty(
      "properties.arguments.properties.escaped.$ref",
      "#/properties/arguments%2F$defs%2Fvalue",
    )
    expect(schema).toHaveProperty(
      "properties.arguments.properties.children.items.$ref",
      "#/properties/arguments",
    )
    expect(schema).toHaveProperty(
      "properties.arguments.properties.value.default",
      literal,
    )
    expect(schema).toHaveProperty(
      "properties.arguments.properties.child",
      resource,
    )
    expect(schema).toHaveProperty("properties.arguments.dependencies.count", [])
    expect(parameters).toEqual(original)
    const validate = new AjvJsonSchemaValidator().getValidator(schema!)
    expect(
      validate({
        arguments: {
          value: "hello",
          escaped: "encoded",
          children: [{ count: 1 }],
        },
      }).valid,
    ).toBe(true)
    expect(validate({ arguments: { count: "wrong" } }).valid).toBe(false)
    expect(validate({ arguments: { value: "hello", count: 1 } }).valid).toBe(
      false,
    )
  })

  test("preserves references within a root resource identified by $id", () => {
    const parameters = {
      $id: "https://example.test/tool",
      definitions: { value: { type: "string" } },
      type: "object",
      properties: { value: { $ref: "#/definitions/value" } },
      allOf: [{ required: ["value"] }],
    }
    const translation = translate({ tools: [{ ...browserTool, parameters }] })
    const schema = translation.messagesPayload.tools?.[0]?.input_schema
    expect(schema).toHaveProperty("properties.arguments", parameters)
    const validate = new AjvJsonSchemaValidator().getValidator(schema!)
    expect(validate({ arguments: { value: "hello" } }).valid).toBe(true)
    expect(validate({ arguments: { value: 1 } }).valid).toBe(false)
  })

  test.each([
    { code: "await tab.getState()", title: "Checking the page" },
    { completion_summary: "Checked the page" },
  ])("unwraps a non-streaming call and wraps its replay", (argumentsValue) => {
    const translation = translate()
    const result = translateAnthropicToResponses(
      responseWithInput({ arguments: argumentsValue }),
      translation,
    )
    const call = result.output[0]
    expect(call).toMatchObject({
      type: "function_call",
      call_id: "call-browser",
      name: browserTool.name,
      arguments: JSON.stringify(argumentsValue),
    })
    if (call.type !== "function_call") throw new Error("Expected function call")
    const replay = translate({
      input: [
        { type: "message", role: "user", content: "Use the browser" },
        { ...call },
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "Success",
        },
      ],
    })
    expect(replay.messagesPayload.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: call.call_id,
          input: { arguments: argumentsValue },
        },
      ],
    })
    expect(replay.messagesPayload.messages[2]).toMatchObject({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: call.call_id, content: "Success" },
      ],
    })
  })

  test("restores namespaced tool identities loaded from additional_tools", () => {
    const toolChoice = {
      type: "function" as const,
      name: "js",
      namespace: "browser",
    }
    const translation = translate({
      tools: [],
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "browser",
              tools: [{ ...browserTool, name: "js" }],
            },
          ],
        },
        { type: "message", role: "user", content: "Use the browser" },
        {
          type: "function_call",
          call_id: "call-old",
          name: "js",
          namespace: "browser",
          arguments: '{"code":"old"}',
        },
      ],
      tool_choice: toolChoice,
    })
    expect(translation.messagesPayload.tool_choice).toEqual({
      type: "tool",
      name: "browser__js",
    })
    expect(translation.messagesPayload.messages[1]).toMatchObject({
      content: [{ name: "browser__js", input: { arguments: { code: "old" } } }],
    })
    const response = responseWithInput({
      arguments: { completion_summary: "Done" },
    })
    response.content = [
      {
        type: "tool_use",
        id: "call-browser",
        name: "browser__js",
        input: { arguments: { completion_summary: "Done" } },
      },
    ]
    expect(
      translateAnthropicToResponses(response, translation).output[0],
    ).toMatchObject({
      name: "js",
      namespace: "browser",
      arguments: '{"completion_summary":"Done"}',
    })
  })

  test.each([
    {},
    { code: "unwrapped" },
    { arguments: null },
    { arguments: [] },
    { arguments: "string" },
    { arguments: {}, extra: true },
  ])("rejects invalid upstream wrappers %j", (input) => {
    expect(() =>
      translateAnthropicToResponses(responseWithInput(input), translate()),
    ).toThrow(ResponsesMessagesTranslationError)
    try {
      translateAnthropicToResponses(responseWithInput(input), translate())
    } catch (error) {
      expect(error).toMatchObject({ status: 502 })
    }
  })
})

describe("Messages wrapped argument streams", () => {
  test.each([
    {
      code: 'text("中文 😀 \\ \\" { arguments: {} }")',
      title: "Checking the page",
    },
    { completion_summary: "Checked the page" },
  ])(
    "unwraps fragmented JSON and returns replayable events",
    async (argumentsValue) => {
      const source = [
        toolStart(),
        ...Array.from(JSON.stringify({ arguments: argumentsValue }), (char) =>
          toolDelta(char),
        ),
        { type: "content_block_stop" as const, index: 0 },
        { type: "message_stop" as const },
      ]
      const events = await collect(source)
      expect(
        events.filter(
          (event) => event.type === "response.function_call_arguments.delta",
        ),
      ).toMatchObject([{ delta: JSON.stringify(argumentsValue) }])
      expect(
        events.find(
          (event) => event.type === "response.function_call_arguments.done",
        ),
      ).toMatchObject({ arguments: JSON.stringify(argumentsValue) })
      const completed = events.at(-1)
      expect(completed?.type).toBe("response.completed")
      if (completed?.type !== "response.completed")
        throw new Error("Expected completed response")
      const outputDone = events.find(
        (event) => event.type === "response.output_item.done",
      )
      if (
        outputDone?.type !== "response.output_item.done"
        || outputDone.item.type !== "function_call"
      ) {
        throw new Error("Expected completed function call")
      }
      expect(outputDone.item).toMatchObject({
        name: browserTool.name,
        arguments: JSON.stringify(argumentsValue),
      })
      const replay = translate({ input: [{ ...outputDone.item }] })
      expect(replay.messagesPayload.messages[0]).toMatchObject({
        content: [{ input: { arguments: argumentsValue } }],
      })
      expect(events.map((event) => event.sequence_number)).toEqual(
        events.map((_, index) => index),
      )
    },
  )

  test("keeps parallel wrapped, ordinary, and custom calls separate", async () => {
    const translation = translate({
      stream: true,
      tools: [
        browserTool,
        { ...browserTool, name: "ordinary", parameters: { type: "object" } },
        { type: "custom", name: "exec" },
      ],
    })
    const events = await collect(
      [
        toolStart(),
        toolStart(1, "ordinary"),
        toolStart(2, "exec"),
        toolStart(3, browserTool.name, {
          arguments: { completion_summary: "Done" },
        }),
        toolDelta('{"arguments":{"code":', 0),
        toolDelta('{"value":', 1),
        toolDelta('{"input":"text(1)"}', 2),
        toolDelta('"text(2)"}}', 0),
        toolDelta("1}", 1),
        { type: "message_stop" },
      ],
      translation,
    )
    const deltas = events.filter(
      (event) => event.type === "response.function_call_arguments.delta",
    )
    expect(deltas).toMatchObject([
      { output_index: 1, delta: '{"value":' },
      { output_index: 1, delta: "1}" },
      { output_index: 0, delta: '{"code":"text(2)"}' },
      { output_index: 3, delta: '{"completion_summary":"Done"}' },
    ])
    const completed = events.at(-1)
    if (completed?.type !== "response.completed")
      throw new Error("Expected completed response")
    const output = events.flatMap((event) =>
      event.type === "response.output_item.done" ? [event.item] : [],
    )
    expect(output).toMatchObject([
      { arguments: '{"code":"text(2)"}' },
      { arguments: '{"value":1}' },
      { type: "custom_tool_call", input: "text(1)" },
      { arguments: '{"completion_summary":"Done"}' },
    ])
  })

  test.each([
    '{"arguments":',
    '{"code":"unwrapped"}',
    '{"arguments":null}',
    '{"arguments":{},"extra":true}',
    "",
  ])(
    "fails malformed wrappers without completing a tool call %j",
    async (partialJson) => {
      const events = await collect([
        toolStart(),
        toolDelta(partialJson),
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ])
      expect(events.at(-1)?.type).toBe("response.failed")
      expect(
        events.some(
          (event) => event.type === "response.function_call_arguments.delta",
        ),
      ).toBe(false)
      expect(
        events.some((event) => event.type === "response.output_item.done"),
      ).toBe(false)
    },
  )

  test("fails an interrupted stream without emitting buffered arguments", async () => {
    const events = await collect([
      toolStart(),
      toolDelta('{"arguments":{"code":"partial'),
    ])
    expect(events.at(-1)?.type).toBe("response.failed")
    expect(
      events.some(
        (event) => event.type === "response.function_call_arguments.delta",
      ),
    ).toBe(false)
  })
  describe("token limit", () => {
    const maxTokens: AnthropicStreamEventData = {
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
      usage: { output_tokens: 4 },
    }
    const stop: AnthropicStreamEventData = {
      type: "content_block_stop",
      index: 0,
    }

    test.each([
      {
        name: "after content_block_stop",
        json: '{"arguments":{"code":"par',
        closed: true,
      },
      {
        name: "without content_block_stop",
        json: '{"arguments":{"code":"par',
        closed: false,
      },
      { name: "before any arguments", json: "", closed: false },
    ])(
      "keeps a wrapped call cut off by the token limit incomplete ($name)",
      async ({ json, closed }) => {
        const source: Array<AnthropicStreamEventData> = [toolStart()]
        if (json) source.push(toolDelta(json))
        if (closed) source.push(stop)
        source.push(maxTokens, { type: "message_stop" })
        const events = await collect(source)
        expect(events.at(-1)?.type).toBe("response.incomplete")
        const done = events.filter(
          (event) => event.type === "response.output_item.done",
        )
        expect(done).toHaveLength(1)
        expect(done[0]).toMatchObject({
          item: {
            type: "function_call",
            name: browserTool.name,
            arguments: "{}",
            status: "incomplete",
          },
        })
        expect(
          events.filter(
            (event) => event.type === "response.function_call_arguments.done",
          ),
        ).toMatchObject([{ arguments: "{}" }])
      },
    )

    test("unwraps a complete call when the limit is reached after it", async () => {
      const events = await collect([
        toolStart(),
        toolDelta('{"arguments":{"completion_summary":"Done"}}'),
        stop,
        maxTokens,
        { type: "message_stop" },
      ])
      expect(events.at(-1)?.type).toBe("response.incomplete")
      expect(
        events.find((event) => event.type === "response.output_item.done"),
      ).toMatchObject({
        item: {
          arguments: '{"completion_summary":"Done"}',
          status: "completed",
        },
      })
    })

    test("still fails a malformed wrapper when the stop reason is not a token limit", async () => {
      const events = await collect([
        toolStart(),
        toolDelta('{"arguments":'),
        stop,
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 4 },
        },
        { type: "message_stop" },
      ])
      expect(events.at(-1)?.type).toBe("response.failed")
    })

    test("keeps an empty incomplete call in a non-streaming response", () => {
      const result = translateAnthropicToResponses(
        { ...responseWithInput({}), stop_reason: "max_tokens" },
        translate(),
      )
      expect(result.status).toBe("incomplete")
      expect(result.output[0]).toMatchObject({
        type: "function_call",
        arguments: "{}",
        status: "incomplete",
      })
    })
  })
})
