import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ResponseStreamEvent,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  buildResponsesItemOwnershipKey,
  extractAnthropicResponsesItemOwnerKeys,
  extractResponsesResultOwnerKeys,
  extractResponsesStreamEventOwnerKeys,
} from "~/routes/messages/responses-item-ownership"

describe("responses item ownership", () => {
  test("extracts hashed owner keys from Anthropic thinking signatures", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "enc-reasoning@rs_123",
            },
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "cm1#enc-compaction@cmp_123",
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    }

    const keys = extractAnthropicResponsesItemOwnerKeys(payload)

    expect(keys).toEqual([
      buildResponsesItemOwnershipKey("id", "rs_123"),
      buildResponsesItemOwnershipKey("encrypted_content", "enc-reasoning"),
      buildResponsesItemOwnershipKey("id", "cmp_123"),
      buildResponsesItemOwnershipKey("encrypted_content", "enc-compaction"),
    ])
    expect(keys.join("\n")).not.toContain("enc-reasoning")
    expect(keys.join("\n")).not.toContain("enc-compaction")
  })

  test("extracts owner keys from Responses result output", () => {
    const result = {
      output: [
        {
          id: "rs_result",
          type: "reasoning",
          encrypted_content: "enc-result",
        },
        {
          id: "cmp_result",
          type: "compaction",
          encrypted_content: "enc-cmp-result",
        },
      ],
    } as Pick<ResponsesResult, "output">

    expect(extractResponsesResultOwnerKeys(result)).toEqual([
      buildResponsesItemOwnershipKey("id", "rs_result"),
      buildResponsesItemOwnershipKey("encrypted_content", "enc-result"),
      buildResponsesItemOwnershipKey("id", "cmp_result"),
      buildResponsesItemOwnershipKey("encrypted_content", "enc-cmp-result"),
    ])
  })

  test("extracts owner keys from Responses output_item.done stream events", () => {
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 1,
      item: {
        id: "rs_stream",
        type: "reasoning",
        encrypted_content: "enc-stream",
      },
    } as ResponseStreamEvent

    expect(extractResponsesStreamEventOwnerKeys(event)).toEqual([
      buildResponsesItemOwnershipKey("id", "rs_stream"),
      buildResponsesItemOwnershipKey("encrypted_content", "enc-stream"),
    ])
  })
})
