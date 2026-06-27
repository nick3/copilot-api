import { describe, expect, it } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import {
  INTERNAL_CHAT_METADATA_PASSTHROUGH_KEY,
  stripInternalChatMetadataPassthrough,
} from "~/routes/responses/utils"

const KEY = INTERNAL_CHAT_METADATA_PASSTHROUGH_KEY

const makePayload = (input: ResponsesPayload["input"]): ResponsesPayload => ({
  model: "gpt-5",
  input,
})

describe("stripInternalChatMetadataPassthrough", () => {
  it("strips the field from a single input item", () => {
    const payload = makePayload([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
        [KEY]: { turn_id: "abc" },
      },
    ] as ResponsesPayload["input"])

    stripInternalChatMetadataPassthrough(payload)

    const item = (payload.input as Array<Record<string, unknown>>)[0]
    expect(KEY in item).toBe(false)
    // Other fields are preserved.
    expect(item.type).toBe("message")
    expect(item.role).toBe("user")
    expect(item.content).toEqual([{ type: "input_text", text: "hi" }])
  })

  it("strips the field from multiple, mixed item types", () => {
    const payload = makePayload([
      {
        type: "message",
        role: "user",
        content: "one",
        [KEY]: { turn_id: "t1" },
      },
      {
        type: "function_call",
        call_id: "c1",
        name: "foo",
        arguments: "{}",
        [KEY]: { turn_id: "t1" },
      },
      {
        type: "function_call_output",
        call_id: "c1",
        output: "ok",
        [KEY]: { turn_id: "t1" },
      },
    ] as ResponsesPayload["input"])

    stripInternalChatMetadataPassthrough(payload)

    for (const item of payload.input as Array<Record<string, unknown>>) {
      expect(KEY in item).toBe(false)
    }
    // Sanity: structural fields survive on each item.
    const items = payload.input as Array<Record<string, unknown>>
    expect(items[1].name).toBe("foo")
    expect(items[2].output).toBe("ok")
  })

  it("leaves other fields and items without the key untouched", () => {
    const payload = makePayload([
      { type: "message", role: "user", content: "no-field" },
      { type: "message", role: "assistant", content: "also-none" },
    ] as ResponsesPayload["input"])

    stripInternalChatMetadataPassthrough(payload)

    expect(payload.input).toEqual([
      { type: "message", role: "user", content: "no-field" },
      { type: "message", role: "assistant", content: "also-none" },
    ] as ResponsesPayload["input"])
  })

  it("does not recurse into nested content", () => {
    const payload = makePayload([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "hi",
            // A same-named key nested in content must NOT be stripped: only
            // top-level item metadata is rejected by upstream.
            [KEY]: { turn_id: "nested" },
          },
        ],
        [KEY]: { turn_id: "top" },
      },
    ] as ResponsesPayload["input"])

    stripInternalChatMetadataPassthrough(payload)

    const item = (payload.input as Array<Record<string, unknown>>)[0]
    expect(KEY in item).toBe(false)
    const content = item.content as Array<Record<string, unknown>>
    expect(KEY in content[0]).toBe(true)
  })

  it("is a no-op when input is missing", () => {
    const payload = { model: "gpt-5" } as unknown as ResponsesPayload
    expect(() => stripInternalChatMetadataPassthrough(payload)).not.toThrow()
    expect(payload.input).toBeUndefined()
  })

  it("is a no-op when input is a string", () => {
    const payload = makePayload("just a string")
    stripInternalChatMetadataPassthrough(payload)
    expect(payload.input).toBe("just a string")
  })

  it("is a no-op when input is an empty array", () => {
    const payload = makePayload([] as ResponsesPayload["input"])
    stripInternalChatMetadataPassthrough(payload)
    expect(payload.input).toEqual([] as ResponsesPayload["input"])
  })

  it("ignores non-object entries inside input", () => {
    const payload = makePayload([
      null,
      "weird",
      { type: "message", role: "user", content: "x", [KEY]: { turn_id: "t" } },
    ] as unknown as ResponsesPayload["input"])

    expect(() => stripInternalChatMetadataPassthrough(payload)).not.toThrow()

    const items = payload.input as Array<unknown>
    expect(items[0]).toBeNull()
    expect(items[1]).toBe("weird")
    expect(KEY in (items[2] as Record<string, unknown>)).toBe(false)
  })
})
