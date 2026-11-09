import type { ServerSentEventMessage } from "fetch-event-stream"

import { HTTPError } from "~/lib/error"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "./anthropic-types"

export class MessagesToolArgumentsError extends HTTPError {
  constructor(message: string) {
    super(
      message,
      Response.json(
        {
          type: "error",
          error: { type: "api_error", message },
        },
        { status: 502 },
      ),
    )
    this.name = "MessagesToolArgumentsError"
  }
}

export function wrapToolInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!["oneOf", "allOf", "anyOf"].some((keyword) => keyword in schema))
    return schema
  const { $schema, ...parameters } = schema
  return {
    ...($schema ? { $schema } : {}),
    type: "object",
    properties: { arguments: relocateToolSchemaReferences(parameters) },
    required: ["arguments"],
    additionalProperties: false,
  }
}

export function unwrapToolArguments(
  input: unknown,
  name: string,
): Record<string, unknown> {
  if (
    !isRecord(input)
    || Object.keys(input).length !== 1
    || !isRecord(input.arguments)
  ) {
    throw new MessagesToolArgumentsError(
      `Invalid wrapped arguments for tool '${name}'`,
    )
  }
  return input.arguments
}

interface ToolInputBuffer {
  name: string
  json: string
  // The stop reason arrives after content_block_stop, so a stop whose input
  // cannot be decoded waits here until message_delta shows whether a token
  // limit cut the call short.
  stop?: ServerSentEventMessage
  error?: MessagesToolArgumentsError
}

export class MessagesToolArgumentsAdapter {
  readonly payload: AnthropicMessagesPayload
  private readonly wrappedTools = new Set<string>()

  constructor(payload: AnthropicMessagesPayload) {
    const tools = payload.tools?.map((tool) => {
      if (!tool.input_schema) return tool
      const schema = wrapToolInputSchema(tool.input_schema)
      if (schema === tool.input_schema) return tool
      this.wrappedTools.add(tool.name)
      return { ...tool, input_schema: schema }
    })
    if (this.wrappedTools.size === 0) {
      this.payload = payload
      return
    }
    this.payload = {
      ...payload,
      tools,
      messages: payload.messages.map((message) => {
        if (message.role !== "assistant" || !Array.isArray(message.content))
          return message
        return {
          ...message,
          content: message.content.map((block) =>
            block.type === "tool_use" && this.wrappedTools.has(block.name) ?
              { ...block, input: { arguments: block.input } }
            : block,
          ),
        }
      }),
    }
  }

  decodeResponse(response: AnthropicResponse): AnthropicResponse {
    if (this.wrappedTools.size === 0) return response
    const truncated = response.stop_reason === "max_tokens"
    return {
      ...response,
      content: response.content.map((block) =>
        this.decodeBlock(block, truncated),
      ),
    }
  }

  async *decodeStream(
    chunks: AsyncIterable<ServerSentEventMessage>,
  ): AsyncGenerator<ServerSentEventMessage> {
    if (this.wrappedTools.size === 0) {
      yield* chunks
      return
    }
    const buffers = new Map<number, ToolInputBuffer>()
    for await (const chunk of chunks) {
      if (!chunk.data || chunk.data === "[DONE]") {
        yield chunk
        continue
      }
      const event = JSON.parse(chunk.data) as AnthropicStreamEventData
      if (event.type === "error") {
        yield chunk
        return
      }
      if (event.type === "message_start") {
        yield {
          ...chunk,
          data: JSON.stringify({
            ...event,
            message: this.decodeResponse(event.message),
          }),
        }
        continue
      }
      if (
        event.type === "content_block_start"
        && event.content_block.type === "tool_use"
        && this.wrappedTools.has(event.content_block.name)
      ) {
        const block = event.content_block
        buffers.set(event.index, {
          name: block.name,
          json:
            Object.keys(block.input).length > 0 ?
              JSON.stringify(block.input)
            : "",
        })
        yield {
          ...chunk,
          data: JSON.stringify({
            ...event,
            content_block: { ...block, input: {} },
          }),
        }
        continue
      }
      if (
        event.type === "content_block_delta"
        && event.delta.type === "input_json_delta"
      ) {
        const buffer = buffers.get(event.index)
        if (buffer) {
          buffer.json += event.delta.partial_json
          continue
        }
      }
      if (event.type === "content_block_stop") {
        const buffer = buffers.get(event.index)
        if (buffer) {
          let partialJson: string
          try {
            partialJson = decodeBufferedInput(buffer)
          } catch (error) {
            if (!(error instanceof MessagesToolArgumentsError)) throw error
            buffer.stop = chunk
            buffer.error = error
            continue
          }
          const delta: AnthropicStreamEventData = {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "input_json_delta", partial_json: partialJson },
          }
          yield { ...chunk, event: delta.type, data: JSON.stringify(delta) }
          buffers.delete(event.index)
        }
      }
      if (
        event.type === "message_delta"
        && event.delta.stop_reason
        && buffers.size > 0
      ) {
        if (event.delta.stop_reason !== "max_tokens") {
          throwBufferedFailure(buffers, "Messages stream stopped")
        }
        // A token limit cut these calls short. The stop reason already
        // reports it, so close the calls without arguments instead of failing.
        for (const [index, buffer] of [...buffers].sort(
          (left, right) => left[0] - right[0],
        )) {
          yield buffer.stop ?? createBlockStop(index)
          buffers.delete(index)
        }
      }
      if (event.type === "message_stop" && buffers.size > 0) {
        throwBufferedFailure(buffers, "Messages stream stopped")
      }
      yield chunk
    }
    if (buffers.size > 0) {
      throwBufferedFailure(buffers, "Messages stream ended")
    }
  }

  private decodeBlock(
    block: AnthropicResponse["content"][number],
    truncated: boolean,
  ): AnthropicResponse["content"][number] {
    if (block.type !== "tool_use" || !this.wrappedTools.has(block.name))
      return block
    try {
      return { ...block, input: unwrapToolArguments(block.input, block.name) }
    } catch (error) {
      // A token limit cut the call short; the stop reason already reports it.
      if (truncated) return { ...block, input: {} }
      throw error
    }
  }
}

function decodeBufferedInput(buffer: ToolInputBuffer): string {
  let input: unknown
  try {
    input = JSON.parse(buffer.json) as unknown
  } catch {
    throw new MessagesToolArgumentsError(
      `Invalid wrapped arguments JSON for tool '${buffer.name}'`,
    )
  }
  return JSON.stringify(unwrapToolArguments(input, buffer.name))
}

function throwBufferedFailure(
  buffers: Map<number, ToolInputBuffer>,
  reason: string,
): never {
  for (const buffer of buffers.values()) {
    if (buffer.error) throw buffer.error
  }
  throw new MessagesToolArgumentsError(
    `${reason} before the wrapped tool input completed`,
  )
}

function createBlockStop(index: number): ServerSentEventMessage {
  const stop: AnthropicStreamEventData = { type: "content_block_stop", index }
  return { event: stop.type, data: JSON.stringify(stop) }
}

// Local JSON Pointers must still resolve to the original schema after nesting.
// A subschema with its own $id starts a separate reference scope.
function relocateToolSchemaReferences(schema: unknown): unknown {
  if (!isRecord(schema) || schema.$id) return schema
  const relocated = { ...schema }
  for (const keyword of ["$ref", "$dynamicRef"]) {
    const reference = schema[keyword]
    if (
      typeof reference === "string"
      && (reference === "#" || /^#(?:\/|%2f)/iu.test(reference))
    ) {
      relocated[keyword] = `#/properties/arguments${reference.slice(1)}`
    }
  }
  for (const keyword of [
    "allOf",
    "anyOf",
    "oneOf",
    "prefixItems",
    "items",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "additionalProperties",
    "additionalItems",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "contentSchema",
  ]) {
    if (!(keyword in schema)) continue
    const value = schema[keyword]
    relocated[keyword] =
      Array.isArray(value) ?
        value.map(relocateToolSchemaReferences)
      : relocateToolSchemaReferences(value)
  }
  for (const keyword of [
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
  ]) {
    const value = schema[keyword]
    if (!isRecord(value)) continue
    relocated[keyword] = Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        name,
        relocateToolSchemaReferences(child),
      ]),
    )
  }
  return relocated
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
