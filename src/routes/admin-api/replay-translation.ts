import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { translateToAnthropic } from "~/routes/messages/non-stream-translation"

export type TranslateForReplayInput = {
  upstreamEndpoint: string
  rawText: string
  rawKind: "json" | "sse" | "text"
}

export function translateForReplay(input: TranslateForReplayInput): unknown {
  const { upstreamEndpoint, rawText, rawKind } = input

  // /chat/completions + json → translate OpenAI → Anthropic
  if (upstreamEndpoint.includes("/chat/completions") && rawKind === "json") {
    const parsed = JSON.parse(rawText) as ChatCompletionResponse
    return translateToAnthropic(parsed)
  }

  // /chat/completions + sse → return raw (full SSE translation is complex, defer)
  if (upstreamEndpoint.includes("/chat/completions") && rawKind === "sse") {
    return rawText
  }

  // /v1/messages → identity (raw IS anthropic format)
  if (upstreamEndpoint.includes("/v1/messages")) {
    if (rawKind === "json") {
      return JSON.parse(rawText) as unknown
    }
    return rawText
  }

  // /responses → return raw (responses translation is complex, defer)
  if (upstreamEndpoint.includes("/responses")) {
    return rawText
  }

  return null
}
