import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import {
  buildCodexRequestHeaders,
  CODEX_API_BASE_URL,
} from "~/services/codex/create-responses"

interface CodexModelDefinition {
  contextWindow: number
  id: string
  input: Array<"text" | "image">
  maxTokens: number
  name: string
  reasoningEfforts: Array<string>
}

const CODEX_MODELS: Array<CodexModelDefinition> = [
  {
    contextWindow: 100_000,
    id: "gpt-5.3-codex-spark",
    input: ["text"],
    maxTokens: 32_000,
    name: "GPT-5.3 Codex Spark",
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  {
    contextWindow: 272_000,
    id: "gpt-5.4-mini",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.4 mini",
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  {
    contextWindow: 272_000,
    id: "gpt-5.5",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.5",
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  {
    contextWindow: 872_000,
    id: "gpt-5.6-sol",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.6 Sol",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    contextWindow: 872_000,
    id: "gpt-5.6-terra",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.6 Terra",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    contextWindow: 872_000,
    id: "gpt-5.6-luna",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.6 Luna",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    contextWindow: 872_000,
    id: "gpt-6-astra",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-6 Astra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
]

export function resolveCodexModelsUrl(
  requestUrl: string,
  baseUrl: string = CODEX_API_BASE_URL,
): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/u, "")
  const codexBaseUrl = normalizedBaseUrl || CODEX_API_BASE_URL
  const modelsUrl = `${codexBaseUrl.replace(/\/codex(?:\/models)?$/u, "")}/codex/models`
  const upstreamUrl = new URL(modelsUrl)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardCodexModels(
  requestUrl: string,
  requestHeaders: Headers,
  baseUrl: string = CODEX_API_BASE_URL,
): Promise<Response> {
  const headers = buildCodexRequestHeaders(requestHeaders)
  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  return await fetch(resolveCodexModelsUrl(requestUrl, baseUrl), {
    method: "GET",
    headers,
  })
}

function normalizeCodexModel(model: CodexModelDefinition): Model {
  const supportsVision = model.input.includes("image")

  return {
    capabilities: {
      family: "gpt",
      limits: {
        max_context_window_tokens: model.contextWindow,
        max_output_tokens: model.maxTokens,
        max_prompt_tokens: model.contextWindow,
      },
      object: "model_capabilities",
      supports: {
        adaptive_thinking: true,
        parallel_tool_calls: true,
        reasoning_effort: model.reasoningEfforts,
        streaming: true,
        tool_calls: true,
        vision: supportsVision,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id: model.id,
    model_picker_enabled: true,
    name: model.name,
    object: "model",
    preview: false,
    supported_endpoints: ["/v1/messages", "/v1/responses"],
    vendor: "openai",
    version: "chatgpt-codex",
  }
}

export function getModels(): ModelsResponse {
  return {
    object: "list",
    data: CODEX_MODELS.map((model) => normalizeCodexModel(model)),
  }
}
