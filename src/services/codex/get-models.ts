import type { Model, ModelsResponse } from "~/services/copilot/get-models"

interface CodexModelDefinition {
  contextWindow: number
  id: string
  input: Array<"text" | "image">
  maxTokens: number
  name: string
}

const CODEX_MODELS: Array<CodexModelDefinition> = [
  {
    contextWindow: 100_000,
    id: "gpt-5.3-codex-spark",
    input: ["text"],
    maxTokens: 32_000,
    name: "GPT-5.3 Codex Spark",
  },
  {
    contextWindow: 400_000,
    id: "gpt-5.4",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.4",
  },
  {
    contextWindow: 400_000,
    id: "gpt-5.4-mini",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.4 mini",
  },
  {
    contextWindow: 272_000,
    id: "gpt-5.5",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.5",
  },
  {
    contextWindow: 272_000,
    id: "gpt-5.6-sol",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.6 Sol",
  },
  {
    contextWindow: 272_000,
    id: "gpt-5.6-terra",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.6 Terra",
  },
  {
    contextWindow: 272_000,
    id: "gpt-5.6-luna",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.6 Luna",
  },
]

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
        reasoning_effort: ["minimal", "low", "medium", "high", "xhigh"],
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
