import { createHandlerLogger } from "~/lib/logger"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

export type UsageTokens = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export function normalizeOpenAIUsage(
  usage: ChatCompletionResponse["usage"] | ChatCompletionChunk["usage"],
): UsageTokens {
  const cacheCreationInputTokens =
    usage?.prompt_tokens_details?.cache_creation_input_tokens
  const cacheReadInputTokens = usage?.prompt_tokens_details?.cached_tokens
  const inputTokens =
    usage?.prompt_tokens === undefined ?
      undefined
    : Math.max(
        0,
        usage.prompt_tokens
          - (cacheCreationInputTokens ?? 0)
          - (cacheReadInputTokens ?? 0),
      )
  return {
    inputTokens,
    outputTokens: usage?.completion_tokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  }
}

export function createProviderTokenUsageRecorder(options: {
  endpoint: string
  model: string
  providerName: string
}): (usage: UsageTokens) => void {
  const logger = createHandlerLogger(`provider-${options.providerName}`)
  return (usage) => {
    logger.debug(`${options.endpoint} usage`, {
      model: options.model,
      provider: options.providerName,
      ...usage,
    })
  }
}
