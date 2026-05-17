import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import {
  applyLastMessageCacheControl,
  getLastMessageContentCacheControl,
  mergeToolResultForClaude,
  prepareMessagesApiPayload,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "../src/routes/messages/preprocess"

describe("mergeToolResultForClaude turn boundaries", () => {
  test("removes tool reference turn boundaries before merging", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)
    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })

  test("restores cache_control captured before stripping Tool loaded", () => {
    const message: AnthropicMessagesPayload["messages"][number] = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
        {
          type: "text",
          text: "Tool loaded.",
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        },
      ],
    }
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [message],
    }

    const lastMessageCacheControl = getLastMessageContentCacheControl(
      payload.messages.at(-1),
    )
    stripToolReferenceTurnBoundary(payload)
    mergeToolResultForClaude(payload)
    applyLastMessageCacheControl(payload, lastMessageCacheControl)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        },
      ],
    })
  })

  test("keeps Tool loaded text when the message has no tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "Tool loaded.",
        },
      ],
    })
  })
})

describe("mergeToolResultForClaude content merging", () => {
  test("merges text blocks into matching tool_result blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Follow-up details",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo\n\nFollow-up details",
        },
      ],
    })
  })

  test("adds cache_control to the merged tool_result when trailing text is absorbed", () => {
    const message: AnthropicMessagesPayload["messages"][number] = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "[Pasted ~4 lines]",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    }
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [message],
    }

    const lastMessageCacheControl = getLastMessageContentCacheControl(
      payload.messages.at(-1),
    )
    mergeToolResultForClaude(payload)
    applyLastMessageCacheControl(payload, lastMessageCacheControl)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo\n\n[Pasted ~4 lines]",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("appends all text blocks to the last tool_result when counts differ", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second",
            },
            {
              type: "text",
              text: "extra one",
            },
            {
              type: "text",
              text: "extra two",
            },
            {
              type: "text",
              text: "extra three",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: "second\n\nextra one\n\nextra two\n\nextra three",
        },
      ],
    })
  })

  test("does not merge text into tool_result blocks that contain tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Follow-up details",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })
})

describe("mergeToolResultForClaude attachments", () => {
  test("merges attachments into matching tool_result blocks when counts match", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
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
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "first output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second output",
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
  })

  test("appends image and document blocks to the last tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "binary output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
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
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "binary output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
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
  })
})

describe("mergeToolResultForClaude attachments fallback", () => {
  test("appends all attachments to the last tool_result when counts differ", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data-1",
              },
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
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "image-data-2",
              },
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first output",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data-1",
              },
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
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "image-data-2",
              },
            },
          ],
        },
      ],
    })
  })

  test("keeps text merging and appends attachments to the last tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first",
            },
            {
              type: "text",
              text: "first detail",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second",
            },
            {
              type: "text",
              text: "second detail",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first\n\nfirst detail",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "text",
              text: "second\n\nsecond detail",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
      ],
    })
  })
})

describe("mergeToolResultForClaude attachments with tool_reference", () => {
  test("falls back to the last tool_result without tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "binary output",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "text",
              text: "binary output",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "image-data",
              },
            },
          ],
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })
})

describe("sanitizeIdeTools", () => {
  test("continues to remove executeCode when Responses tool search is disabled", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__executeCode",
          description: "Execute code",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__getDiagnostics",
          description: "Old description",
          input_schema: { type: "object" },
        },
      ],
    }

    sanitizeIdeTools(payload)

    expect(payload.tools?.map((tool) => tool.name)).toEqual([
      "mcp__tool_search__search",
      "mcp__ide__getDiagnostics",
    ])
  })

  test("does not keep executeCode for GPT models without the tool search bridge", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "mcp__ide__executeCode",
          description: "Execute code",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__getDiagnostics",
          description: "Old description",
          input_schema: { type: "object" },
        },
      ],
    }

    sanitizeIdeTools(payload)

    expect(payload.tools?.map((tool) => tool.name)).toEqual([
      "mcp__ide__getDiagnostics",
    ])
  })
})

describe("prepareMessagesApiPayload", () => {
  test("strips cache_control scope, filters thinking blocks, and enables adaptive thinking", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        } as AnthropicMessagesPayload["system"] extends Array<infer T> ? T
        : never,
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "sig-1",
            },
            {
              type: "thinking",
              thinking: "Keep this",
              signature: "sig-2",
            },
            {
              type: "thinking",
              thinking: "Drop this too",
              signature: "bad@sig",
            },
            {
              type: "text",
              text: "Visible text",
            },
          ],
        },
        {
          role: "user",
          content: "hello",
        },
      ],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    const systemBlock = (
      payload.system as unknown as Array<Record<string, unknown>>
    )[0]
    expect(systemBlock).toEqual({
      type: "text",
      text: "system prompt",
      cache_control: {
        type: "ephemeral",
      },
    })
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Keep this",
          signature: "sig-2",
        },
        {
          type: "text",
          text: "Visible text",
        },
      ],
    })
    expect(payload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
    expect(payload.output_config).toEqual({ effort: "xhigh" })
  })

  test("does not enable adaptive thinking when tool choice forces tool use", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tool_choice: {
        type: "tool",
        name: "apply_patch",
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })
})
