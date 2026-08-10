import { describe, expect, test } from "bun:test"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type {
  ResponsesPayload,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import {
  decodeMessagesCompaction,
  encodeMessagesCompaction,
  MESSAGES_COMPACTION_PREFIX,
  ResponsesMessagesTranslationError,
  translateAnthropicToResponses,
  translateResponsesToMessages,
} from "~/routes/responses/messages-translation"
import {
  responsesResultToStreamEvents,
  translateMessagesStream,
} from "~/routes/responses/messages-stream-translation"

const translate = (payload: Omit<ResponsesPayload, "model">) =>
  translateResponsesToMessages(
    { model: "claude-sonnet-4.6", ...payload },
    { model: "claude-sonnet-4.6" },
  )

const expectCanonicalBase64 = (value: string | undefined) => {
  expect(value).toBeTruthy()
  if (!value) return
  expect(Buffer.from(value, "base64").toString("base64")).toBe(value)
}

describe("Responses Lite to Messages translation", () => {
  test("groups the first five developer prompts into two system blocks", () => {
    const result = translate({
      instructions: "Base instructions",
      input: [
        { role: "developer", content: "Developer one", type: "message" },
        {
          role: "developer",
          content: [
            { type: "input_text", text: "Developer two, part one" },
            { type: "input_text", text: "Developer two, part two" },
          ],
          type: "message",
        },
        { role: "developer", content: "Developer three", type: "message" },
        { role: "developer", content: "Developer four", type: "message" },
        { role: "developer", content: "Developer five", type: "message" },
        { role: "developer", content: "Developer six", type: "message" },
        { role: "user", content: "First user message", type: "message" },
        { role: "user", content: "Second user message", type: "message" },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      { type: "text", text: "Base instructions" },
      { type: "text", text: "Developer one" },
      {
        type: "text",
        text: [
          "Developer two, part one",
          "Developer two, part two",
          "Developer three",
          "Developer four",
          "Developer five",
        ].join("\n\n"),
      },
    ])
    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "First user message" },
      { role: "user", content: "Second user message" },
    ])
  })

  test("converts developer messages after the first user to user messages", () => {
    const result = translate({
      input: [
        { role: "developer", content: "Initial developer", type: "message" },
        { role: "user", content: "First user message", type: "message" },
        { role: "developer", content: "Later developer", type: "message" },
        {
          role: "developer",
          content: [
            { type: "input_text", text: "Later developer, part one" },
            { type: "input_text", text: "Later developer, part two" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
              detail: "auto",
            },
          ],
          type: "message",
        },
        { role: "user", content: "Second user message", type: "message" },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      { type: "text", text: "Initial developer" },
    ])
    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "First user message" },
      { role: "user", content: "Later developer" },
      {
        role: "user",
        content: [
          { type: "text", text: "Later developer, part one" },
          { type: "text", text: "Later developer, part two" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
          },
        ],
      },
      { role: "user", content: "Second user message" },
    ])
  })

  test("translates agent messages and later developer messages to user", () => {
    const result = translate({
      input: [
        { role: "developer", content: "Initial developer", type: "message" },
        {
          id: "amsg-1",
          type: "agent_message",
          author: "agent-a",
          recipient: "agent-b",
          content: [
            { type: "input_text", text: "Agent handoff" },
            {
              type: "encrypted_content",
              encrypted_content: "encrypted-handoff",
            },
          ],
        },
        { role: "developer", content: "Later developer", type: "message" },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      { type: "text", text: "Initial developer" },
    ])
    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Agent handoff" },
          { type: "text", text: "encrypted-handoff" },
        ],
      },
      { role: "user", content: "Later developer" },
    ])
  })

  test("keeps initial developer prompts when replaying a compaction", () => {
    const result = translate({
      input: [
        { role: "developer", content: "Developer one", type: "message" },
        { role: "developer", content: "Developer two", type: "message" },
        {
          id: "cmp-1",
          type: "compaction",
          encrypted_content: encodeMessagesCompaction("Existing handoff"),
        },
        { role: "user", content: "Continue", type: "message" },
      ],
    })

    expect(result.messagesPayload.system).toEqual([
      { type: "text", text: "Developer one" },
      { type: "text", text: "Developer two" },
    ])
    expect(result.messagesPayload.messages).toEqual([
      {
        role: "user",
        content:
          "The previous conversation was compacted. Continue from this handoff summary:\n\nExisting handoff",
      },
      { role: "user", content: "Continue" },
    ])
  })

  test("encodes compaction content as canonical Base64", () => {
    const summary = "Existing handoff"
    const encoded = encodeMessagesCompaction(summary)
    const legacy = `${MESSAGES_COMPACTION_PREFIX}${Buffer.from(summary, "utf8").toString("base64url")}`

    expectCanonicalBase64(encoded)
    expect(decodeMessagesCompaction(encoded)).toBe(summary)
    expect(decodeMessagesCompaction(legacy)).toBe(summary)
    expect(decodeMessagesCompaction("not base64")).toBeNull()
  })

  test("loads custom tools from input.additional_tools", () => {
    const result = translate({
      input: [
        {
          id: "tools-1",
          role: "developer",
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply a patch to workspace files",
              format: { type: "text" },
            },
          ],
          type: "additional_tools",
        },
        { role: "user", content: "Update the file", type: "message" },
      ],
      tool_choice: { type: "custom", name: "apply_patch" },
    })

    expect(result.messagesPayload.tools).toEqual([
      {
        name: "apply_patch",
        description: "Apply a patch to workspace files",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    ])
    expect(result.messagesPayload.tool_choice).toEqual({
      type: "tool",
      name: "apply_patch",
    })
    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "Update the file" },
    ])
  })

  test("merges input reasoning with the following assistant message", () => {
    const result = translate({
      input: [
        { role: "user", content: "What is 2 + 2?", type: "message" },
        {
          id: "reasoning-1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Calculate the sum." }],
          encrypted_content: "reasoning-signature",
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "4" }],
          type: "message",
        },
        { role: "user", content: "Thanks", type: "message" },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "What is 2 + 2?" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Calculate the sum.",
            signature: "reasoning-signature",
          },
          { type: "text", text: "4" },
        ],
      },
      { role: "user", content: "Thanks" },
    ])
  })

  test("restores namespace on Responses function calls", () => {
    const translation = translate({
      input: [
        {
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "workspace",
              tools: [
                {
                  type: "function",
                  name: "read_file",
                  description: "Read a workspace file",
                  parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                  },
                  strict: false,
                },
              ],
            },
          ],
          type: "additional_tools",
        },
        { role: "user", content: "Read the file", type: "message" },
      ],
    })
    expect(translation.messagesPayload.tools?.[0]?.name).toBe(
      "workspace__read_file",
    )

    const response: AnthropicResponse = {
      content: [
        {
          type: "tool_use",
          id: "call-read",
          name: "workspace__read_file",
          input: { path: "README.md" },
        },
      ],
      id: "msg_namespace",
      model: "claude-sonnet-4.6",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 8, output_tokens: 3 },
    }

    const result = translateAnthropicToResponses(response, translation)
    expect(result.output[0]).toMatchObject({
      type: "function_call",
      call_id: "call-read",
      name: "read_file",
      namespace: "workspace",
      arguments: JSON.stringify({ path: "README.md" }),
    })
  })

  test("keeps input tools when a compaction request trims older input", () => {
    const result = translate({
      input: [
        {
          role: "developer",
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply a patch",
            },
          ],
          type: "additional_tools",
        },
        {
          id: "cmp-1",
          type: "compaction",
          encrypted_content: encodeMessagesCompaction("Existing handoff"),
        },
        { role: "user", content: "Continue", type: "message" },
        { type: "compaction_trigger" },
      ],
      tool_choice: "auto",
    })

    expect(result.compaction).toBe(true)
    expect(result.messagesPayload.tools).toEqual([
      {
        name: "apply_patch",
        description: "Apply a patch",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    ])
    expect(result.messagesPayload.tool_choice).toEqual({ type: "auto" })
  })

  test("uses the Codex local handoff prompt for compaction requests", () => {
    const expectedPrompt = [
      "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
      "Do NOT continue the task, make changes, or call any tools. Your only output must be the handoff summary.",
      "",
      "Include:",
      "- Current progress and key decisions made",
      "- Important context, constraints, or user preferences",
      "- What remains to be done (clear next steps)",
      "- Any critical data, examples, or references needed to continue",
      "",
      "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
      "",
      "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
    ].join("\n")

    const result = translate({
      input: [
        { role: "user", content: "Implement the feature", type: "message" },
        { type: "compaction_trigger" },
      ],
    })

    expect(result.messagesPayload.messages).toEqual([
      { role: "user", content: "Implement the feature" },
      { role: "user", content: expectedPrompt },
    ])
  })

  test("does not support Responses tool search mode", () => {
    expect(() =>
      translate({
        input: [
          {
            type: "tool_search_output",
            call_id: "search-1",
            tools: [{ type: "function", name: "hidden", parameters: null }],
          },
          { role: "user", content: "Continue", type: "message" },
        ],
      }),
    ).toThrow(ResponsesMessagesTranslationError)

    expect(() =>
      translate({
        input: "hello",
        tools: [{ type: "tool_search", execution: "client" }],
      }),
    ).toThrow("does not support tool 'tool_search'")

    expect(() =>
      translate({
        input: "hello",
        tools: [{ type: "apply_patch", name: "apply_patch" }],
      }),
    ).toThrow("does not support tool 'apply_patch'")
  })

  test("maps only valid Anthropic effort levels", () => {
    expect(
      translate({ input: "hello", reasoning: { effort: "minimal" } })
        .messagesPayload.output_config,
    ).toEqual({ effort: "low" })
    expect(
      translate({ input: "hello", reasoning: { effort: "none" } })
        .messagesPayload.output_config,
    ).toBeUndefined()
    expect(
      translate({ input: "hello", reasoning: { effort: "max" } })
        .messagesPayload.output_config,
    ).toEqual({ effort: "max" })
  })

  test("translates an apply_patch tool use back to a custom tool call", () => {
    const translation = translate({
      input: [
        {
          role: "developer",
          tools: [{ type: "custom", name: "apply_patch" }],
          type: "additional_tools",
        },
        { role: "user", content: "Patch it", type: "message" },
      ],
    })
    const response: AnthropicResponse = {
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "apply_patch",
          input: { input: "*** Begin Patch" },
        },
      ],
      id: "msg_1",
      model: "claude-sonnet-4.6",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 10, output_tokens: 4 },
    }

    const result = translateAnthropicToResponses(response, translation)
    expect(result.output).toMatchObject([
      {
        type: "custom_tool_call",
        call_id: "call-1",
        name: "apply_patch",
        input: "*** Begin Patch",
      },
    ])
  })

  test("streams apply_patch as Responses custom tool events", async () => {
    const translation = translate({
      input: [
        {
          role: "developer",
          tools: [{ type: "custom", name: "apply_patch" }],
          type: "additional_tools",
        },
        { role: "user", content: "Patch it", type: "message" },
      ],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_stream",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-stream",
          name: "apply_patch",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"input": "*** Begin',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: ' Patch"',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "}" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    const toolDeltas = events.flatMap((event) =>
      event.type === "response.custom_tool_call_input.delta" ?
        [event.delta]
      : [],
    )
    expect(toolDeltas).toEqual(["*** Begin", " Patch"])
    const toolDone = events.find(
      (event) => event.type === "response.custom_tool_call_input.done",
    )
    expect(toolDone?.type).toBe("response.custom_tool_call_input.done")
    if (toolDone?.type === "response.custom_tool_call_input.done") {
      expect(typeof toolDone.item_id).toBe("string")
      expect(toolDone.name).toBe("apply_patch")
      expect(toolDone.input).toBe("*** Begin Patch")
    }
    const outputDone = events.find(
      (event) =>
        event.type === "response.output_item.done"
        && event.item.type === "custom_tool_call",
    )
    expect(outputDone?.type).toBe("response.output_item.done")
    if (
      outputDone?.type === "response.output_item.done"
      && outputDone.item.type === "custom_tool_call"
    ) {
      expect(outputDone.item).toMatchObject({
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch",
        status: "completed",
      })
    }
    const completed = events.at(-1)
    expect(completed?.type).toBe("response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.output).toEqual([])
    }
  })

  test("uses Base64 encrypted content for stream reasoning signatures", async () => {
    const translation = translate({
      input: "Explain the result",
      stream: true,
    })
    const signature = Buffer.from("real-signature", "utf8").toString("base64")
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_reasoning_stream",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "Unsigned reasoning" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking", thinking: "Signed reasoning" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "signature_delta", signature },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }
    const reasoningItems = events.flatMap((event) => {
      if (
        event.type !== "response.output_item.added"
        && event.type !== "response.output_item.done"
      ) {
        return []
      }
      return event.item.type === "reasoning" ? [event.item] : []
    })

    expect(reasoningItems).toHaveLength(4)
    const fallback = reasoningItems[0]?.encrypted_content
    expect(fallback).toBe(reasoningItems[1]?.encrypted_content)
    expect(fallback).toBe(reasoningItems[2]?.encrypted_content)
    expect(reasoningItems[3]?.encrypted_content).toBe(signature)
    for (const item of reasoningItems) {
      expectCanonicalBase64(item.encrypted_content)
    }
  })

  test("uses Base64 encrypted content for stream compaction", async () => {
    const translation = translate({
      input: [
        { role: "user", content: "Implement the feature", type: "message" },
        { type: "compaction_trigger" },
      ],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_compaction_stream",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "Current progress" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " and next steps" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }
    const compaction = events.find(
      (event) =>
        event.type === "response.output_item.done"
        && event.item.type === "compaction",
    )

    expect(compaction?.type).toBe("response.output_item.done")
    if (
      compaction?.type === "response.output_item.done"
      && compaction.item.type === "compaction"
    ) {
      expectCanonicalBase64(compaction.item.encrypted_content)
      expect(decodeMessagesCompaction(compaction.item.encrypted_content)).toBe(
        "Current progress and next steps",
      )
    }
  })

  test("streams initial custom tool input without terminal output", async () => {
    const translation = translate({
      input: "Patch it",
      tools: [{ type: "custom", name: "apply_patch" }],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_initial_input",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-initial",
          name: "apply_patch",
          input: { input: "from start" },
        },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    const delta = events.find(
      (event) => event.type === "response.custom_tool_call_input.delta",
    )
    expect(delta).toMatchObject({ delta: "from start" })
    const completed = events.at(-1)
    expect(completed?.type).toBe("response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.output).toEqual([])
    }
  })

  test("keeps function tool arguments incremental after state cleanup", async () => {
    const translation = translate({
      input: "Read files",
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
          strict: false,
        },
      ],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_function_stream",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-first",
          name: "read_file",
          input: { path: "first" },
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call-second",
          name: "read_file",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"second"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    const deltas = events.flatMap((event) =>
      event.type === "response.function_call_arguments.delta" ?
        [event.delta]
      : [],
    )
    expect(deltas).toEqual(['{"path":"first"}', '{"path":', '"second"}'])
    const doneEvents = events.filter(
      (event) => event.type === "response.function_call_arguments.done",
    )
    expect(doneEvents).toHaveLength(2)
    expect(
      events
        .filter((event) => event.type === "response.output_item.added")
        .map((event) =>
          event.type === "response.output_item.added" ? event.output_index : -1,
        ),
    ).toEqual([0, 1])
  })

  test("fails malformed custom input without terminal output items", async () => {
    const translation = translate({
      input: "Patch it",
      tools: [{ type: "custom", name: "apply_patch" }],
      stream: true,
    })
    const source = [
      {
        type: "message_start",
        message: {
          content: [],
          id: "msg_invalid_custom",
          model: "claude-sonnet-4.6",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-invalid",
          name: "apply_patch",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"wrong":' },
      },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const events: Array<ResponseStreamEvent> = []
    for await (const event of translateMessagesStream(chunks(), translation)) {
      events.push(event)
    }

    expect(events.some((event) => event.type === "error")).toBe(true)
    expect(
      events.some(
        (event) => event.type === "response.custom_tool_call_input.done",
      ),
    ).toBe(false)
    const failed = events.at(-1)
    expect(failed?.type).toBe("response.failed")
    if (failed?.type === "response.failed") {
      expect(failed.response.output).toEqual([])
    }
  })

  test("omits output from synthesized terminal stream events", () => {
    const translation = translate({ input: "hello", stream: true })
    const result = translateAnthropicToResponses(
      {
        content: [{ type: "text", text: "hello" }],
        id: "msg_synthesized",
        model: "claude-sonnet-4.6",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 2, output_tokens: 1 },
      },
      translation,
    )

    const events = responsesResultToStreamEvents(result)
    expect(
      events.some((event) => event.type === "response.output_item.done"),
    ).toBe(true)
    const completed = events.at(-1)
    expect(completed?.type).toBe("response.completed")
    if (completed?.type === "response.completed") {
      expect(completed.response.output).toEqual([])
    }
  })
})
