import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/lib/types/responses"

import {
  sanitizeUnsupportedInputFields,
  shouldUseMessagesAdapter,
} from "~/routes/responses/utils"

describe("sanitizeUnsupportedInputFields", () => {
  test("removes Codex internal_chat_message_metadata_passthrough from input items", () => {
    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          internal_chat_message_metadata_passthrough: {
            turn_id: "turn-1",
          },
          role: "user",
        },
        {
          content: [{ text: "world", type: "input_text" }],
          role: "assistant",
        },
      ],
      model: "gpt-5.5",
    } as unknown as ResponsesPayload

    expect(sanitizeUnsupportedInputFields(payload)).toBe(1)
    expect(
      (payload.input as Array<Record<string, unknown>>)[0]
        .internal_chat_message_metadata_passthrough,
    ).toBeUndefined()
  })

  test("returns zero when input is missing or unsupported fields are absent", () => {
    expect(sanitizeUnsupportedInputFields({ model: "gpt-5.5" })).toBe(0)
    expect(
      sanitizeUnsupportedInputFields({
        input: [{ content: "hello", role: "user" }],
        model: "gpt-5.5",
      }),
    ).toBe(0)
  })
})

test("Codex non-GPT models use Messages adaptation even with only a native Responses endpoint", () => {
  expect(
    shouldUseMessagesAdapter({
      model: "deepseek-v4",
      codexClient: true,
      transport: "http",
      endpoints: ["/responses"],
    }),
  ).toBe(true)
  expect(
    shouldUseMessagesAdapter({
      model: "gpt-5.5",
      codexClient: true,
      transport: "websocket",
      endpoints: ["/responses"],
    }),
  ).toBe(false)
  expect(
    shouldUseMessagesAdapter({
      model: "codex-model",
      codexClient: true,
      transport: "http",
    }),
  ).toBe(false)
  expect(
    shouldUseMessagesAdapter({
      model: "deepseek-v4",
      codexClient: false,
      transport: "http",
    }),
  ).toBe(false)
  expect(
    shouldUseMessagesAdapter({
      model: "claude-test",
      codexClient: false,
      transport: null,
      endpoints: ["/v1/messages"],
    }),
  ).toBe(true)
  expect(
    shouldUseMessagesAdapter({
      model: "unknown",
      codexClient: false,
      transport: null,
    }),
  ).toBe(false)
})
