import { describe, expect, test } from "bun:test"
import consola from "consola"

import type {
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"

import { collectResponsesStreamResult } from "~/routes/messages/responses-stream-collection"

type StreamChunk = {
  data?: string
  event?: string
}

const makeResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult => ({
  id: "resp-collection",
  object: "response",
  created_at: 0,
  model: "gpt-test",
  output: [
    {
      id: "msg-original",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "original",
          annotations: [],
        },
      ],
    },
  ],
  output_text: "original",
  status: "completed",
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: 1,
  tool_choice: null,
  tools: [],
  top_p: null,
  ...overrides,
})

const makeStream = (chunks: Array<StreamChunk>): ResponsesStream =>
  (async function* () {
    for (const chunk of chunks) {
      await Promise.resolve()
      yield chunk
    }
  })()

const collect = (chunks: Array<StreamChunk>) =>
  collectResponsesStreamResult({
    upstreamResponse: makeStream(chunks),
    logger: consola,
  })

describe("responses stream collection", () => {
  test("collects output items by index and returns the terminal response", async () => {
    const result = makeResult({ output: [], output_text: "" })
    const firstItem = makeResult().output[0]
    const secondItem = {
      id: "msg-second",
      type: "message" as const,
      role: "assistant" as const,
      status: "completed" as const,
      content: [
        {
          type: "output_text",
          text: "second",
          annotations: [],
        },
      ],
    }

    const collected = await collect([
      { event: "ping", data: "ignored" },
      {},
      { data: "not-json" },
      {
        data: JSON.stringify({
          item: secondItem,
          output_index: 1,
          sequence_number: 1,
          type: "response.output_item.done",
        }),
      },
      {
        data: JSON.stringify({
          item: firstItem,
          output_index: 0,
          sequence_number: 2,
          type: "response.output_item.done",
        }),
      },
      {
        data: JSON.stringify({
          copilot_usage: { total_nano_aiu: 9 },
          response: result,
          sequence_number: 3,
          type: "response.completed",
        }),
      },
      { data: "[DONE]" },
    ])

    expect(collected.output).toEqual([firstItem, secondItem])
    expect(collected.copilot_usage).toEqual({ total_nano_aiu: 9 })
  })

  test("keeps terminal output when no output-item events were collected", async () => {
    const result = makeResult({ status: "incomplete" })
    const collected = await collect([
      {
        data: JSON.stringify({
          response: result,
          sequence_number: 1,
          type: "response.incomplete",
        }),
      },
    ])

    expect(collected).toEqual(result)
  })

  test("throws the upstream error message", async () => {
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            code: "upstream_error",
            error: { code: "upstream_error", message: "stream failed" },
            message: "fallback message",
            param: null,
            sequence_number: 1,
            type: "error",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("stream failed")
  })

  test("throws the failed response message", async () => {
    const failedResult = makeResult({
      error: { code: "upstream_error", message: "response failed" },
      output: [],
      output_text: "",
      status: "failed",
    })
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            response: failedResult,
            sequence_number: 1,
            type: "response.failed",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("response failed")
  })

  test("uses the configured error prefix for a failed response without details", async () => {
    const failedResult = makeResult({
      output: [],
      output_text: "",
      status: "failed",
    })
    let thrown: unknown
    try {
      await collectResponsesStreamResult({
        errorMessagePrefix: "Codex responses stream",
        upstreamResponse: makeStream([
          {
            data: JSON.stringify({
              response: failedResult,
              sequence_number: 1,
              type: "response.failed",
            }),
          },
        ]),
        logger: consola,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("Codex responses stream failed")
  })

  test("throws when the stream ends without a terminal event", async () => {
    let thrown: unknown
    try {
      await collect([{ data: "[DONE]" }])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      "Responses stream ended without a terminal event",
    )
  })

  test("throws when a terminal event omits its response", async () => {
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            sequence_number: 1,
            type: "response.failed",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      "Responses stream ended without a response",
    )
  })
})
