import type { AccountContext } from "~/lib/types/account"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { copilotFetchJsonWithRetry } from "~/lib/resilient-copilot-fetch"
import { accountFromState } from "~/lib/state"

export const createEmbeddings = async (
  payload: EmbeddingRequest,
  account?: AccountContext,
) => {
  const ctx = account ?? accountFromState()
  if (!ctx.copilotToken) throw new Error("Copilot token not found")

  const accountId = ctx.id ?? "unknown"

  const url = `${copilotBaseUrl(ctx)}/embeddings`
  const init: RequestInit = {
    method: "POST",
    headers: copilotHeaders(ctx),
    body: JSON.stringify(payload),
  }

  return copilotFetchJsonWithRetry<EmbeddingResponse>({
    accountId,
    operation: "POST /embeddings",
    url,
    init,
    failureMessage: "Failed to create embeddings",
  })
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
