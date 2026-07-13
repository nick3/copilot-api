import { describe, expect, test } from "bun:test"

import type { AnthropicStreamEventData } from "~/routes/messages/anthropic-types"
import type {
  ResponseCreatedEvent,
  ResponseOutputItemAddedEvent,
  ResponseReasoningSummaryPartAddedEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseReasoningSummaryTextDoneEvent,
} from "~/services/copilot/create-responses"

import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { REASONING_SUMMARY_SEPARATOR } from "~/routes/messages/responses-translation"

const createFunctionCallAddedEvent = (): ResponseOutputItemAddedEvent => ({
  type: "response.output_item.added",
  sequence_number: 1,
  output_index: 1,
  item: {
    id: "item-1",
    type: "function_call",
    call_id: "call-1",
    name: "TodoWrite",
    arguments: "",
    status: "in_progress",
  },
})

describe("translateResponsesStreamEvent tool calls", () => {
  test("streams function call arguments across deltas", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 2,
          delta: '{"todos":',
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 3,
          delta: "[]}",
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 4,
          arguments: '{"todos":[]}',
        },
        state,
      ),
    ].flat()

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "TodoWrite",
        input: {},
      })
    }

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(2)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"todos":',
    })
    expect(deltas[1].delta).toEqual({
      type: "input_json_delta",
      partial_json: "[]}",
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("emits full arguments when only done payload is present", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments:
            '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
        },
        state,
      ),
    ].flat()

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json:
        '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("uses namespace as streamed function call tool name", () => {
    const state = createResponsesStreamState()

    const events = translateResponsesStreamEvent(
      {
        ...createFunctionCallAddedEvent(),
        item: {
          id: "item-1",
          type: "function_call",
          call_id: "call-1",
          name: "invoke",
          namespace: "mcp__fetch__fetch",
          arguments: "",
          status: "in_progress",
        },
      },
      state,
    )

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "mcp__fetch__fetch",
        input: {},
      })
    }
  })

  test("streams tool_search_call as the bridge tool use", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 1,
          item: {
            id: "search-1",
            type: "tool_search_call",
            call_id: "call-search",
            arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
            status: "in_progress",
          },
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 1,
          item: {
            id: "search-1",
            type: "tool_search_call",
            call_id: "call-search",
            arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
            status: "completed",
          },
        },
        state,
      ),
    ].flat()

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-search",
        name: "mcp__tool_search__search",
        input: {},
      })
    }

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"names":"mcp__fetch__fetch,TaskList"}',
    })
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("streams tool_search_call with the configured bridge alias", () => {
    const state = createResponsesStreamState({
      toolSearchName: "tool_search_search",
    })

    const events = translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 1,
        item: {
          id: "search-1",
          type: "tool_search_call",
          call_id: "call-search",
          arguments: { names: ["mcp__fetch__fetch"] },
          status: "in_progress",
        },
      },
      state,
    )

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-search",
        name: "tool_search_search",
        input: {},
      })
    }
  })
})

describe("translateResponsesStreamEvent usage", () => {
  test("maps Responses cache writes in message_start usage", () => {
    const state = createResponsesStreamState()
    const event: ResponseCreatedEvent = {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp_cache_write",
        object: "response",
        created_at: 0,
        model: "gpt-5.6-sol",
        output: [],
        output_text: "",
        status: "in_progress",
        usage: {
          input_tokens: 100,
          input_tokens_details: {
            cached_tokens: 12,
            cache_write_tokens: 20,
          },
          output_tokens: 0,
          total_tokens: 100,
        },
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: null,
        tools: [],
        top_p: null,
      },
    }

    const events = translateResponsesStreamEvent(event, state)
    const messageStart = events.find(
      (translatedEvent) => translatedEvent.type === "message_start",
    )

    expect(messageStart).toBeDefined()
    if (messageStart?.type === "message_start") {
      expect(messageStart.message.usage).toEqual({
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 12,
        input_tokens: 68,
        output_tokens: 0,
      })
    }
  })

  test("clamps message_start input when cache usage exceeds input", () => {
    const state = createResponsesStreamState()
    const event: ResponseCreatedEvent = {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp_cache_overflow",
        object: "response",
        created_at: 0,
        model: "gpt-5.6-sol",
        output: [],
        output_text: "",
        status: "in_progress",
        usage: {
          input_tokens: 10,
          input_tokens_details: {
            cached_tokens: 12,
            cache_write_tokens: 20,
          },
          output_tokens: 0,
          total_tokens: 10,
        },
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: null,
        tools: [],
        top_p: null,
      },
    }

    const events = translateResponsesStreamEvent(event, state)
    const messageStart = events.find(
      (translatedEvent) => translatedEvent.type === "message_start",
    )

    expect(messageStart).toBeDefined()
    if (messageStart?.type === "message_start") {
      expect(messageStart.message.usage.input_tokens).toBe(0)
    }
  })
})

describe("translateResponsesStreamEvent reasoning summaries", () => {
  test("separates delta and done-only summaries exactly once", () => {
    const state = createResponsesStreamState()
    const partAdded = (summaryIndex: number, sequenceNumber: number) =>
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_part.added",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: summaryIndex,
          sequence_number: sequenceNumber,
          part: { type: "summary_text", text: "" },
        } satisfies ResponseReasoningSummaryPartAddedEvent,
        state,
      )

    const events = [
      partAdded(0, 1),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.done",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 0,
          sequence_number: 2,
          text: "**Preparing the request**",
        } satisfies ResponseReasoningSummaryTextDoneEvent,
        state,
      ),
      partAdded(1, 3),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 1,
          sequence_number: 4,
          delta: "**Running ",
        } satisfies ResponseReasoningSummaryTextDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 1,
          sequence_number: 5,
          delta: "the tool**",
        } satisfies ResponseReasoningSummaryTextDeltaEvent,
        state,
      ),
      partAdded(2, 6),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.done",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 2,
          sequence_number: 7,
          text: "**Finishing**",
        } satisfies ResponseReasoningSummaryTextDoneEvent,
        state,
      ),
    ].flat()

    const thinking = events
      .flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "thinking_delta"
        ) ?
          [event.delta.thinking]
        : [],
      )
      .join("")

    expect(thinking).toBe(
      "**Preparing the request**"
        + REASONING_SUMMARY_SEPARATOR
        + "**Running the tool**"
        + REASONING_SUMMARY_SEPARATOR
        + "**Finishing**",
    )
  })
})
