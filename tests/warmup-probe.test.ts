import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { shouldUseSmallModelForWarmup } from "~/routes/messages/utils"

describe("shouldUseSmallModelForWarmup", () => {
  test("routes anthropic beta requests without tools to the small model", () => {
    const payload: AnthropicMessagesPayload = {
      model: "copilot/gpt-5.2",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      max_tokens: 16,
    }

    expect(shouldUseSmallModelForWarmup(payload, "beta", false)).toBe(true)
  })

  test("does not route requests with tools to the small model", () => {
    const payload: AnthropicMessagesPayload = {
      model: "copilot/gpt-5.2",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      max_tokens: 16,
      tools: [
        {
          name: "echo",
          input_schema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }

    expect(shouldUseSmallModelForWarmup(payload, "beta", false)).toBe(false)
  })

  test("does not route compact requests to the small model through warmup logic", () => {
    const payload: AnthropicMessagesPayload = {
      model: "copilot/gpt-5.2",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      max_tokens: 16,
    }

    expect(shouldUseSmallModelForWarmup(payload, "beta", true)).toBe(false)
  })
})
