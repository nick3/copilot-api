import type { Context, Env } from "hono"

import { getProviderConfig, type ResolvedProviderConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { createFallbackModel } from "~/lib/provider-model"
import { getTokenCount } from "~/lib/tokenizer"
import { type AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import { normalizeSystemMessages } from "~/routes/messages/preprocess"

const logger = createHandlerLogger("provider-count-tokens-handler")

type ProviderConfigResolver = (
  provider: string,
) => ResolvedProviderConfig | null

const resolveProviderConfig = (
  c: Context,
  provider: string,
): ResolvedProviderConfig | null => {
  const resolver = c.get("providerConfigResolver" as never) as
    | ProviderConfigResolver
    | undefined
  return (resolver ?? getProviderConfig)(provider)
}

export async function handleProviderCountTokens(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  return await handleProviderCountTokensForProvider(c, { payload, provider })
}

export async function handleProviderCountTokensForProvider(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
  },
): Promise<Response> {
  const { payload: anthropicPayload, provider } = options
  normalizeSystemMessages(anthropicPayload)
  const providerConfig = resolveProviderConfig(c, provider)
  if (!providerConfig) {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' not found or disabled`,
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  if (
    typeof anthropicPayload.model !== "string"
    || !Array.isArray(anthropicPayload.messages)
  ) {
    return c.json(
      {
        error: {
          message: "Invalid Anthropic messages count_tokens payload",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const modelId = anthropicPayload.model.trim()
  const modelConfig = providerConfig.models?.[modelId]
  const translationOptions =
    (
      providerConfig.type === "openai-compatible"
      || providerConfig.type === "openai-responses"
    ) ?
      {
        supportPdf: modelConfig?.supportPdf,
        toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
      }
    : undefined

  try {
    const openAIPayload = translateToOpenAI(
      anthropicPayload,
      translationOptions,
    )
    const selectedModel =
      findEndpointModel(modelId) ?? createFallbackModel(modelId)

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    const finalTokenCount = tokenCount.input + tokenCount.output

    logger.debug("provider.count_tokens.success", {
      provider,
      model: anthropicPayload.model,
      input_tokens: finalTokenCount,
    })

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    logger.error("provider.count_tokens.error", {
      provider,
      error,
    })
    return c.json(
      {
        error: {
          message: "Failed to count provider tokens",
          type: "internal_server_error",
        },
      },
      500,
    )
  }
}
