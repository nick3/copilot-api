import type { ConsolaInstance } from "consola"

import type {
  CopilotUsage,
  ResponseStreamEvent,
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"

import { debugJson } from "~/lib/logger"

interface ResponsesStreamCollection {
  outputItemsByIndex: Map<number, ResponsesResult["output"][number]>
}

export const collectResponsesStreamResult = async ({
  errorMessagePrefix = "Responses stream",
  parseEvent = parseResponsesStreamEvent,
  upstreamResponse,
  logger,
}: {
  errorMessagePrefix?: string
  parseEvent?: (data: string) => ResponseStreamEvent | null
  upstreamResponse: ResponsesStream
  logger: ConsolaInstance
}): Promise<ResponsesResult> => {
  const state = createResponsesStreamCollection()

  for await (const chunk of upstreamResponse) {
    const result = collectResponsesStreamChunk({
      chunk,
      errorMessagePrefix,
      logger,
      parseEvent,
      state,
    })
    if (result) {
      return result
    }
  }

  throw new Error(`${errorMessagePrefix} ended without a terminal event`)
}

const collectResponsesStreamChunk = ({
  chunk,
  errorMessagePrefix,
  logger,
  parseEvent,
  state,
}: {
  chunk: { data?: string; event?: string }
  errorMessagePrefix: string
  logger: ConsolaInstance
  parseEvent: (data: string) => ResponseStreamEvent | null
  state: ResponsesStreamCollection
}): ResponsesResult | undefined => {
  debugJson(logger, "Received responses stream chunk:", chunk)
  if (chunk.event === "ping" || !chunk.data || chunk.data === "[DONE]") {
    return
  }

  const parsed = parseEvent(chunk.data)
  if (!parsed) {
    return
  }

  if (parsed.type === "error") {
    throw new Error(
      getStreamErrorMessage(parsed) ?? `${errorMessagePrefix} failed`,
    )
  }

  if (parsed.type === "response.failed") {
    const response = parsed.response
    if (!response) {
      throw new Error("Responses stream ended without a response")
    }
    throw new Error(response.error?.message ?? `${errorMessagePrefix} failed`)
  }

  return collectResponsesStreamEvent(parsed, state)
}

const parseResponsesStreamEvent = (
  data: string,
): ResponseStreamEvent | null => {
  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const createResponsesStreamCollection = (): ResponsesStreamCollection => ({
  outputItemsByIndex: new Map(),
})

const collectResponsesStreamEvent = (
  event: ResponseStreamEvent,
  state: ResponsesStreamCollection,
): ResponsesResult | undefined => {
  switch (event.type) {
    case "response.completed":
    case "response.incomplete": {
      const response = event.response
      if (!response) {
        throw new Error("Responses stream ended without a response")
      }
      response.copilot_usage ??= event.copilot_usage as CopilotUsage
      const output = [...state.outputItemsByIndex.entries()]
        .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
        .map(([, item]) => item)
      return {
        ...response,
        output: output.length > 0 ? output : response.output,
      }
    }
    case "response.output_item.done":
      state.outputItemsByIndex.set(event.output_index, event.item)
      break
  }
}

const getStreamErrorMessage = (
  event: Extract<ResponseStreamEvent, { type: "error" }>,
): string | undefined => {
  return event.error?.message ?? event.message ?? undefined
}
