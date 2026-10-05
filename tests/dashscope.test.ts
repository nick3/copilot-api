import { describe, expect, test } from "bun:test"

import {
  applyOpenAICompatibleContextCache,
  normalizeDashScopeAssistantTextContent,
} from "~/lib/dashscope"
import type { Message } from "~/lib/types/chat-completions"

const buildPayload = (model: string) => ({
  model,
  messages: [
    { content: "system prompt", role: "system" },
    { content: "hello", role: "user" },
  ] as Array<Message>,
})

const collectCacheControls = (messages: Array<Message>): Array<unknown> =>
  messages.flatMap((message) =>
    Array.isArray(message.content) ?
      message.content.flatMap((part) =>
        "cache_control" in part ? [part.cache_control] : [],
      )
    : [],
  )

describe("applyOpenAICompatibleContextCache model restriction", () => {
  test("applies cache_control for qwen models", () => {
    const payload = buildPayload("qwen-plus")
    applyOpenAICompatibleContextCache(payload)
    expect(collectCacheControls(payload.messages)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
    ])
  })

  test("matches qwen case-insensitively", () => {
    const payload = buildPayload("Qwen3-Max")
    applyOpenAICompatibleContextCache(payload)
    expect(collectCacheControls(payload.messages)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
    ])
  })

  test("skips cache_control for non-qwen models", () => {
    const payload = buildPayload("glm-5.2")
    applyOpenAICompatibleContextCache(payload)
    expect(collectCacheControls(payload.messages)).toEqual([])
    expect(payload.messages[0]?.content).toBe("system prompt")
  })

  test("skips cache_control for models with provider prefix", () => {
    const payload = buildPayload("dashscope/qwen-plus")
    applyOpenAICompatibleContextCache(payload)
    expect(collectCacheControls(payload.messages)).toEqual([])
    expect(payload.messages[0]?.content).toBe("system prompt")
  })
})

describe("normalizeDashScopeAssistantTextContent", () => {
  test("only converts assistant arrays made entirely of text", () => {
    const messages: Array<Message> = [
      { role: "assistant", content: [{ type: "text", text: "single" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/a.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]

    normalizeDashScopeAssistantTextContent(messages)

    expect(messages[0]?.content).toBe("single")
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ])
    expect(messages[2]?.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])
  })
})
