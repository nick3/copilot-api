import { describe, expect, it } from "bun:test"

import { requestContext } from "~/lib/request-context"
import { createMcpToolSearchSentinel } from "~/lib/tool-search"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ResponseFunctionCallOutputItem,
  ResponseInputMessage,
  ResponseToolSearchCallItem,
  ResponseToolSearchOutputItem,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"

const samplePayload = {
  model: "claude-3-5-sonnet",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nThis is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.\n</system-reminder>",
        },
        {
          type: "text",
          text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# important-instruction-reminders\nDo what has been asked; nothing more, nothing less.\nNEVER create files unless they're absolutely necessary for achieving your goal.\nALWAYS prefer editing an existing file to creating a new one.\nNEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n\n      \n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>",
        },
        {
          type: "text",
          text: "hi",
        },
        {
          type: "text",
          text: "<system-reminder>\nThe user opened the file c:\\Work2\\copilot-api\\src\\routes\\responses\\translation.ts in the IDE. This may or may not be related to the current task.\n</system-reminder>",
        },
        {
          type: "text",
          text: "hi",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    },
  ],
} as unknown as AnthropicMessagesPayload

const sampleTools = [
  {
    name: "getWeather",
    description: "Gets weather info",
    input_schema: {
      location: {
        type: "string",
      },
    },
  },
]

const jsonStyleUserId = JSON.stringify({
  device_id: "3f4a1b7c8d9e0f1234567890abcdef1234567890abcdef1234567890abcdef12",
  account_uuid: "",
  session_id: "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752",
})

const legacyStyleUserId =
  "user_8b7e2c1d4f6a9b3c0d1e2f3456789abcdeffedcba9876543210fedcba1234567_account__session_7d0e2f61-4b5c-4a9d-8f11-2c3d4e5f6a7b"

const emptySessionUserId = JSON.stringify({
  device_id: "3f4a1b7c8d9e0f1234567890abcdef1234567890abcdef1234567890abcdef12",
  account_uuid: "",
  session_id: "",
})

const subagentAgentId = "agent-123"

describe("translateAnthropicMessagesToResponsesPayload", () => {
  it("converts anthropic text blocks into response input messages", () => {
    const result = translateAnthropicMessagesToResponsesPayload(samplePayload)

    expect(Array.isArray(result.input)).toBe(true)
    const input = result.input as Array<ResponseInputMessage>
    expect(input).toHaveLength(1)

    const message = input[0]
    expect(message.role).toBe("user")
    expect(Array.isArray(message.content)).toBe(true)

    const content = message.content as Array<{ text: string }>
    expect(content.map((item) => item.text)).toEqual([
      "<system-reminder>\nThis is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.\n</system-reminder>",
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# important-instruction-reminders\nDo what has been asked; nothing more, nothing less.\nNEVER create files unless they're absolutely necessary for achieving your goal.\nALWAYS prefer editing an existing file to creating a new one.\nNEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n\n      \n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>",
      "hi",
      "<system-reminder>\nThe user opened the file c:\\Work2\\copilot-api\\src\\routes\\responses\\translation.ts in the IDE. This may or may not be related to the current task.\n</system-reminder>",
      "hi",
    ])
  })

  it("extracts identifiers from JSON-like user_id metadata", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      metadata: {
        user_id: jsonStyleUserId,
      },
      tools: sampleTools,
    })

    expect(result.prompt_cache_key).toBe("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752")
  })

  it("appends subagent agent_id to metadata prompt cache key", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        metadata: {
          user_id: jsonStyleUserId,
        },
        tools: sampleTools,
      },
      { subagentAgentId: ` ${subagentAgentId} ` },
    )

    expect(result.prompt_cache_key).toBe(
      "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752:agent:agent-123",
    )
  })

  it("uses modelOverride without adding it to prompt cache key", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        metadata: {
          user_id: jsonStyleUserId,
        },
        tools: sampleTools,
      },
      { modelOverride: "gpt-5.4" },
    )

    expect(result.model).toBe("gpt-5.4")
    expect(result.prompt_cache_key).toBe("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752")
  })

  it("keeps legacy user_id parsing before JSON fallback", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      metadata: {
        user_id: legacyStyleUserId,
      },
      tools: sampleTools,
    })

    expect(result.prompt_cache_key).toBe("7d0e2f61-4b5c-4a9d-8f11-2c3d4e5f6a7b")
  })

  it("falls back to session affinity when metadata session id is empty", () => {
    const result = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () =>
        translateAnthropicMessagesToResponsesPayload({
          ...samplePayload,
          metadata: {
            user_id: emptySessionUserId,
          },
          tools: sampleTools,
        }),
    )

    expect(result.prompt_cache_key).toBe("opencode-session")
  })

  it("appends subagent agent_id to session affinity fallback", () => {
    const result = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () =>
        translateAnthropicMessagesToResponsesPayload(
          {
            ...samplePayload,
            metadata: {
              user_id: emptySessionUserId,
            },
            tools: sampleTools,
          },
          { subagentAgentId: ` ${subagentAgentId} ` },
        ),
    )

    expect(result.prompt_cache_key).toBe("opencode-session:agent:agent-123")
  })

  it("keeps unrelated system prompt text unchanged", () => {
    const payload = {
      model: "gpt-5.4",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: "ordinary system prompt",
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello gpt54" }],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    const result = translateAnthropicMessagesToResponsesPayload(payload)

    expect(result.instructions).toContain("ordinary system prompt")
    expect(result.instructions).not.toContain("cch=<stable>;")
  })

  it("ignores blank subagent agent_id", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        metadata: {
          user_id: jsonStyleUserId,
        },
        tools: sampleTools,
      },
      { subagentAgentId: "   " },
    )

    expect(result.prompt_cache_key).toBe("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752")
  })

  it("keeps prompt_cache_key null when only subagent agent_id is provided", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        tools: sampleTools,
      },
      { subagentAgentId },
    )

    expect(result.prompt_cache_key).toBeNull()
  })

  it("omits prompt_cache_key when tools are missing", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        metadata: {
          user_id: jsonStyleUserId,
        },
      },
      { subagentAgentId },
    )

    expect(result).not.toHaveProperty("prompt_cache_key")
  })

  it("omits prompt_cache_key when tools are empty", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        metadata: {
          user_id: jsonStyleUserId,
        },
        tools: [],
      },
      { subagentAgentId },
    )

    expect(result).not.toHaveProperty("prompt_cache_key")
  })

  it("maps tool_reference tool results into function_call_output text", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-4.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
          ],
        },
      ],
    })

    const input = result.input as Array<ResponseFunctionCallOutputItem>
    expect(input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: "Tool AskUserQuestion loaded",
          },
        ],
        status: "completed",
      },
    ])
  })

  it("maps document tool results into function_call_output input_file content", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-4.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: "pdf-data",
                  },
                  title: "report.pdf",
                },
              ],
            },
          ],
        },
      ],
    })

    const input = result.input as Array<ResponseFunctionCallOutputItem>
    expect(input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_file",
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,pdf-data",
          },
        ],
        status: "completed",
      },
    ])
  })

  it("maps top-level user documents into input_file content while preserving text order", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-4.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please analyze this file.",
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
              title: "report.pdf",
            },
          ],
        },
      ],
    })

    const input = result.input as Array<ResponseInputMessage>
    expect(input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Please analyze this file.",
          },
          {
            type: "input_file",
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,pdf-data",
          },
        ],
      },
    ])
  })

  it("defaults top-level user document filenames to document.pdf", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-4.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "pdf-data",
              },
            },
          ],
        },
      ],
    })

    const input = result.input as Array<ResponseInputMessage>
    expect(input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "document.pdf",
            file_data: "data:application/pdf;base64,pdf-data",
          },
        ],
      },
    ])
  })

  it("converts bridge and deferred tools into Responses tool_search and namespaces", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fetch a page" }],
      tools: [
        {
          name: "mcp__tool_search__search",
          description: "Search deferred tools",
          input_schema: {
            type: "object",
            properties: {
              names: { type: "string" },
            },
            required: ["names"],
          },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
            required: ["url"],
          },
        },
        {
          name: "chrome-devtools_click",
          description: "Click an element",
          input_schema: {
            type: "object",
            properties: {
              uid: { type: "string" },
            },
            required: ["uid"],
          },
        },
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
            required: ["file_path"],
          },
        },
      ],
    })

    expect(result.parallel_tool_calls).toBe(true)
    expect(result.tools).toEqual([
      {
        type: "tool_search",
        execution: "client",
        description:
          "Load deferred tools by exact name before using them. Return only the searchable tool names you need for the next step.",
        parameters: {
          type: "object",
          properties: {
            names: {
              type: "array",
              description: "Exact deferred tool names to load.",
              items: {
                type: "string",
                enum: ["mcp__fetch__fetch", "chrome-devtools_click"],
              },
              minItems: 1,
            },
          },
          required: ["names"],
          additionalProperties: false,
        },
      },
      {
        type: "namespace",
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        tools: [
          {
            type: "function",
            name: "mcp__fetch__fetch",
            description: "Fetch a URL",
            parameters: {
              type: "object",
              properties: {
                url: { type: "string" },
              },
              required: ["url"],
            },
            strict: false,
            defer_loading: true,
          },
        ],
      },
      {
        type: "namespace",
        name: "chrome-devtools_click",
        description: "Click an element",
        tools: [
          {
            type: "function",
            name: "chrome-devtools_click",
            description: "Click an element",
            parameters: {
              type: "object",
              properties: {
                uid: { type: "string" },
              },
              required: ["uid"],
            },
            strict: false,
            defer_loading: true,
          },
        ],
      },
      {
        type: "function",
        name: "Read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
        strict: false,
      },
    ])
  })

  it("keeps deferred candidates as normal functions when the bridge tool is absent", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fetch a page" }],
      tools: [
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
          },
        },
        {
          name: "chrome-devtools_click",
          description: "Click an element",
          input_schema: {
            type: "object",
            properties: {
              uid: { type: "string" },
            },
          },
        },
      ],
    })

    expect(result.parallel_tool_calls).toBe(true)
    expect(result.tools).toEqual([
      {
        type: "function",
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
        },
        strict: false,
      },
      {
        type: "function",
        name: "chrome-devtools_click",
        description: "Click an element",
        parameters: {
          type: "object",
          properties: {
            uid: { type: "string" },
          },
        },
        strict: false,
      },
    ])
  })

  it("maps bridge tool_use history into tool_search_call input items", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "mcp__tool_search__search",
              input: { names: "mcp__fetch__fetch" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          input_schema: { type: "object" },
        },
      ],
    })

    const input = result.input as Array<ResponseToolSearchCallItem>
    expect(input).toEqual([
      {
        type: "tool_search_call",
        call_id: "call_search",
        arguments: { names: ["mcp__fetch__fetch"] },
        execution: "client",
        status: "completed",
      },
    ])
  })

  it("preserves namespace on deferred tool_use history", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_shipping_eta",
              name: "get_shipping_eta",
              input: { order_id: "order_42" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "get_shipping_eta",
          input_schema: { type: "object" },
        },
      ],
    })

    expect(result.input).toEqual([
      {
        type: "function_call",
        call_id: "call_shipping_eta",
        name: "get_shipping_eta",
        namespace: "get_shipping_eta",
        arguments: '{"order_id":"order_42"}',
        status: "completed",
      },
    ])
  })

  it("accepts tool_search bridge aliases in tool_use history", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "tool_search_search",
              input: { names: "mcp__fetch__fetch" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "tool_search_search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          input_schema: { type: "object" },
        },
      ],
    })

    const input = result.input as Array<ResponseToolSearchCallItem>
    expect(input).toEqual([
      {
        type: "tool_search_call",
        call_id: "call_search",
        arguments: { names: ["mcp__fetch__fetch"] },
        execution: "client",
        status: "completed",
      },
    ])
  })

  it("rebuilds tool_search_output from tool_reference history", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "mcp__tool_search__search",
              input: { names: "mcp__fetch__fetch" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_search",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "mcp__fetch__fetch",
                },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
          },
        },
      ],
    })

    const input = result.input as Array<
      ResponseToolSearchCallItem | ResponseToolSearchOutputItem
    >
    expect(input[1]).toEqual({
      type: "tool_search_output",
      call_id: "call_search",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          tools: [
            {
              type: "function",
              name: "mcp__fetch__fetch",
              description: "Fetch a URL",
              parameters: {
                type: "object",
                properties: {
                  url: { type: "string" },
                },
              },
              strict: false,
              defer_loading: true,
            },
          ],
        },
      ],
      status: "completed",
    })
  })

  it("rebuilds tool_search_output from bridge sentinel results", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "mcp__tool_search__search",
              input: { names: "TaskList" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_search",
              content: createMcpToolSearchSentinel("TaskList"),
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: { type: "object" },
        },
        {
          name: "TaskList",
          description: "List tasks",
          input_schema: { type: "object" },
        },
      ],
    })

    const input = result.input as Array<
      ResponseToolSearchCallItem | ResponseToolSearchOutputItem
    >
    const output = input[1] as ResponseToolSearchOutputItem
    expect(output.type).toBe("tool_search_output")
    expect(output.execution).toBe("client")
    expect(
      (output.tools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(["TaskList"])
  })
})

describe("translateResponsesResultToAnthropic", () => {
  it("handles reasoning and function call items", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_123",
      object: "response",
      created_at: 0,
      model: "gpt-4.1",
      output: [
        {
          id: "reason_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking about the task." }],
          status: "completed",
          encrypted_content: "encrypted_reasoning_content",
        },
        {
          id: "call_1",
          type: "function_call",
          call_id: "call_1",
          name: "TodoWrite",
          arguments:
            '{"todos":[{"content":"Read src/routes/responses/translation.ts","status":"in_progress"}]}',
          status: "completed",
        },
        {
          id: "message_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Added the task to your todo list.",
              annotations: [],
            },
          ],
        },
      ],
      output_text: "Added the task to your todo list.",
      status: "incomplete",
      usage: {
        input_tokens: 120,
        output_tokens: 36,
        total_tokens: 156,
      },
      error: null,
      incomplete_details: { reason: "content_filter" },
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(anthropicResponse.content).toHaveLength(3)

    const [thinkingBlock, toolUseBlock, textBlock] = anthropicResponse.content

    expect(thinkingBlock.type).toBe("thinking")
    if (thinkingBlock.type === "thinking") {
      expect(thinkingBlock.thinking).toContain("Thinking about the task")
    }

    expect(toolUseBlock.type).toBe("tool_use")
    if (toolUseBlock.type === "tool_use") {
      expect(toolUseBlock.id).toBe("call_1")
      expect(toolUseBlock.name).toBe("TodoWrite")
      expect(toolUseBlock.input).toEqual({
        todos: [
          {
            content: "Read src/routes/responses/translation.ts",
            status: "in_progress",
          },
        ],
      })
    }

    expect(textBlock.type).toBe("text")
    if (textBlock.type === "text") {
      expect(textBlock.text).toBe("Added the task to your todo list.")
    }
  })

  it("uses function_call namespace as the Anthropic tool_use name", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_namespace",
      object: "response",
      created_at: 0,
      model: "gpt-5.4",
      output: [
        {
          id: "call_1",
          type: "function_call",
          call_id: "call_1",
          name: "invoke",
          namespace: "mcp__fetch__fetch",
          arguments: '{"url":"https://example.com"}',
          status: "completed",
        },
      ],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "mcp__fetch__fetch",
        input: {
          url: "https://example.com",
        },
      },
    ])
  })

  it("maps tool_search_call output into the bridge Anthropic tool_use", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_search",
      object: "response",
      created_at: 0,
      model: "gpt-5.4",
      output: [
        {
          id: "search_1",
          type: "tool_search_call",
          call_id: "call_search",
          arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
          status: "completed",
        },
      ],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content).toEqual([
      {
        type: "tool_use",
        id: "call_search",
        name: "mcp__tool_search__search",
        input: {
          names: "mcp__fetch__fetch,TaskList",
        },
      },
    ])
  })
})
