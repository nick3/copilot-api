import type { AccountContext } from "~/lib/types/account"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { captureOutboundHeadersSnapshot } from "~/lib/request-context"
import { accountFromState } from "~/lib/state"

import { copilotFetch } from "./copilot-fetch"

export const createEmbeddings = async (
  payload: EmbeddingRequest,
  account?: AccountContext,
  options?: {
    requestId?: string
  },
) => {
  const ctx = account ?? accountFromState()
  if (!ctx.copilotToken) throw new Error("Copilot token not found")

  const headers = copilotHeaders(ctx)
  captureOutboundHeadersSnapshot(headers)

  const response = await copilotFetch(
    `${copilotBaseUrl(ctx)}/embeddings`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    {
      requestId: options?.requestId,
      callSite: "embeddings",
      capturable: false,
    },
  )

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
