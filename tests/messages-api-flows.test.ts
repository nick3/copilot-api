import { beforeEach, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"

import {
  handleWithChatCompletions,
  prepareCopilotChatCompletionsPayload,
} from "../src/routes/messages/api-flows"

let capturedPayload: ChatCompletionsPayload | null = null

const createChatCompletions = mock(
  (payload: ChatCompletionsPayload): Promise<ChatCompletionResponse> => {
    capturedPayload = payload
    return Promise.resolve({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: payload.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    })
  },
)

const logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof handleWithChatCompletions>[2]["logger"]

const createContext = () =>
  ({
    json: (body: unknown) => Response.json(body),
  }) as Parameters<typeof handleWithChatCompletions>[0]

beforeEach(() => {
  capturedPayload = null
  createChatCompletions.mockClear()
})

test("messages Chat Completions flow adds Copilot cache control to system and latest two non-system messages", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    system: [
      {
        type: "text",
        text: "system prompt",
      },
    ],
    messages: [
      { role: "user", content: "first user" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "second user",
          },
        ],
      },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "latest user" },
      { role: "assistant", content: "latest answer" },
    ],
  }

  const response = await handleWithChatCompletions(createContext(), payload, {
    createChatCompletionsImpl: createChatCompletions,
    logger,
    requestId: "request-1",
  })

  expect(response.status).toBe(200)
  expect(createChatCompletions).toHaveBeenCalledTimes(1)
  expect(capturedPayload?.messages).toEqual([
    {
      role: "system",
      content: "system prompt",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "user",
      content: "first user",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "second user",
        },
      ],
    },
    {
      role: "assistant",
      content: "older answer",
    },
    {
      role: "user",
      content: "latest user",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "assistant",
      content: "latest answer",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
  ])
})

test("Copilot Chat Completions payload preparation marks two system and latest two non-system messages", () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    messages: [
      { role: "system", content: "system one" },
      { role: "system", content: "system two" },
      { role: "system", content: "system three" },
      { role: "user", content: "older user" },
      { role: "assistant", content: "older assistant" },
      { role: "user", content: "latest user" },
      { role: "assistant", content: "latest assistant" },
    ],
  }

  prepareCopilotChatCompletionsPayload(payload)

  expect(payload.messages).toEqual([
    {
      role: "system",
      content: "system one",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "system",
      content: "system two",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "system",
      content: "system three",
    },
    {
      role: "user",
      content: "older user",
    },
    {
      role: "assistant",
      content: "older assistant",
    },
    {
      role: "user",
      content: "latest user",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "assistant",
      content: "latest assistant",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
  ])
})
