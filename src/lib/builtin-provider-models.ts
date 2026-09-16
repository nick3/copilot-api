import {
  dashscopePeakWindows,
  deepseekPeakWindows,
} from "./token-usage/peak-windows"
import type { TokenUsagePricingConfig } from "./token-usage/pricing"
import type { CodexReasoningEffort, ModelReasoningField } from "./config-store"

export type BuiltinProviderInputModality = "text" | "image"

export interface BuiltinProviderModelConfig {
  contextWindow?: number
  defaultReasoningEffort?: CodexReasoningEffort
  inputModalities?: Array<BuiltinProviderInputModality>
  maxOutputTokens?: number
  pricing: TokenUsagePricingConfig
  reasoningEfforts?: Array<CodexReasoningEffort>
  // Message field carrying assistant thinking text in upstream requests,
  // for models that do not follow the default "reasoning_content"
  // convention (e.g. opencode-go hy3/hy4 use the OpenRouter-style
  // "reasoning" field)
  reasoningField?: ModelReasoningField
}

type BuiltinProviderModelCatalog = Record<
  string,
  Record<string, BuiltinProviderModelConfig>
>

export class BuiltinProviderModelRegistry {
  private static readonly catalog: BuiltinProviderModelCatalog = {
    codex: {
      "gpt-5.3-codex": {
        pricing: {
          cachedInput: 0.175,
          input: 1.75,
          output: 14,
        },
      },
      "gpt-5.4": {
        pricing: {
          tiers: [
            {
              cachedInput: 0.25,
              input: 2.5,
              maxInputTokens: 272_000,
              output: 15,
            },
            {
              cachedInput: 0.5,
              input: 5,
              output: 22.5,
            },
          ],
        },
      },
      "gpt-5.4-mini": {
        pricing: {
          tiers: [
            {
              cachedInput: 0.075,
              input: 0.75,
              maxInputTokens: 272_000,
              output: 4.5,
            },
            {
              cachedInput: 0.15,
              input: 1.5,
              output: 6.75,
            },
          ],
        },
      },
      "gpt-5.5": {
        pricing: {
          tiers: [
            {
              cachedInput: 0.5,
              input: 5,
              maxInputTokens: 272_000,
              output: 30,
            },
            {
              cachedInput: 1,
              input: 10,
              output: 45,
            },
          ],
        },
      },
      "gpt-5.6-sol": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 5,
              cachedInput: 0.4,
              input: 4,
              maxInputTokens: 272_000,
              output: 20,
            },
            {
              cacheCreationInput: 10,
              cachedInput: 0.8,
              input: 8,
              output: 30,
            },
          ],
        },
      },
      "gpt-5.6-terra": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 2.5,
              cachedInput: 0.2,
              input: 2,
              maxInputTokens: 272_000,
              output: 12,
            },
            {
              cacheCreationInput: 5,
              cachedInput: 0.4,
              input: 4,
              output: 18,
            },
          ],
        },
      },
      "gpt-5.6-luna": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 0.25,
              cachedInput: 0.02,
              input: 0.2,
              maxInputTokens: 272_000,
              output: 1.2,
            },
            {
              cacheCreationInput: 0.5,
              cachedInput: 0.04,
              input: 0.4,
              output: 1.8,
            },
          ],
        },
      },
      "gpt-6-astra": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 12.5,
              cachedInput: 1,
              input: 10,
              maxInputTokens: 272_000,
              output: 50,
            },
            {
              cacheCreationInput: 25,
              cachedInput: 2,
              input: 20,
              output: 75,
            },
          ],
        },
      },
    },
    dashscope: {
      "glm-5.1": {
        contextWindow: 202_752,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          tiers: [
            {
              cachedInput: 1.2,
              cacheCreationInput: 7.5,
              explicitCachedInput: 0.6,
              input: 6,
              maxInputTokens: 32_000,
              output: 24,
            },
            {
              cachedInput: 1.6,
              cacheCreationInput: 10,
              explicitCachedInput: 0.8,
              input: 8,
              maxInputTokens: 200_000,
              output: 28,
            },
          ],
        },
      },
      "glm-5.2": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 2,
          cacheCreationInput: 10,
          explicitCachedInput: 0.8,
          input: 8,
          output: 28,
        },
      },
      "ZHIPU/GLM-5.3": {
        contextWindow: 1_048_576,
        inputModalities: ["text"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 2,
          input: 8,
          output: 28,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "ZHIPU/GLM-5.3-Flash": {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 0.23,
          input: 0.8,
          output: 2.8,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "qwen3.7-max": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 2.4,
          cacheCreationInput: 15,
          explicitCachedInput: 1.2,
          input: 12,
          output: 36,
        },
      },
      "qwen3.8-max": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 1.5,
          cacheCreationInput: 15,
          explicitCachedInput: 1,
          input: 12,
          output: 36,
        },
      },
      "qwen3.8-max-0902": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 1.5,
          cacheCreationInput: 15,
          explicitCachedInput: 1,
          input: 12,
          output: 36,
        },
      },
      "qwen3.8-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 0.1,
          cacheCreationInput: 1.25,
          explicitCachedInput: 0.1,
          input: 0.8,
          output: 2.7,
        },
      },
      "deepseek-v4-flash-0731": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.3,
          input: 3,
          offPeak: {
            cachedInput: 0.15,
            input: 1.5,
            output: 4.5,
          },
          output: 9,
          peakWindows: dashscopePeakWindows,
        },
      },
      "deepseek-v4.1-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 393_216,
        pricing: {
          cachedInput: 0.2,
          input: 2,
          offPeak: {
            cachedInput: 0.1,
            input: 1,
            output: 4,
          },
          output: 8,
          peakWindows: dashscopePeakWindows,
        },
      },
      "qwen3.7-plus": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          tiers: [
            {
              cachedInput: 0.4,
              cacheCreationInput: 2.5,
              explicitCachedInput: 0.2,
              input: 2,
              maxInputTokens: 256_000,
              output: 8,
            },
            {
              cachedInput: 1.2,
              cacheCreationInput: 7.5,
              explicitCachedInput: 0.6,
              input: 6,
              maxInputTokens: 1_000_000,
              output: 24,
            },
          ],
        },
      },
      "kimi/kimi-k3": {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 2,
          input: 20,
          output: 100,
        },
      },
    },
    deepseek: {
      "deepseek-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 384_000,
        pricing: {
          cachedInput: 0.04,
          input: 2,
          offPeak: {
            cachedInput: 0.02,
            input: 1,
            output: 4,
          },
          output: 8,
          peakWindows: deepseekPeakWindows,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "deepseek-v4-pro": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.3,
          input: 9,
          offPeak: {
            cachedInput: 0.15,
            input: 4.5,
            output: 13.5,
          },
          output: 27,
          peakWindows: deepseekPeakWindows,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
    },
    "opencode-go": {
      hy3: {
        contextWindow: 256_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.035,
          input: 0.14,
          output: 0.58,
        },
        reasoningField: "reasoning",
      },
      "hy4-preview": {
        contextWindow: 1_024_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.042,
          input: 0.834,
          output: 2.501,
        },
        reasoningEfforts: ["high"],
        reasoningField: "reasoning",
      },
      "gpt-5.6-luna": {
        pricing: {
          tiers: [
            {
              cacheCreationInput: 0.125,
              cachedInput: 0.01,
              input: 0.1,
              maxInputTokens: 272_000,
              output: 0.6,
            },
            {
              cacheCreationInput: 0.25,
              cachedInput: 0.02,
              input: 0.2,
              output: 0.9,
            },
          ],
        },
      },
      "glm-5.2": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.26,
          input: 1.4,
          output: 4.4,
        },
      },
      "glm-5.3": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.26,
          input: 1.4,
          output: 4.4,
        },
      },
      "glm-5.3-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 0.015,
          input: 0.075,
          output: 0.25,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "muse-spark-1.2-contributor": {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 0.002,
          input: 0.1,
          output: 0.2,
        },
        reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      },
      "muse-spark-1.3-contributor": {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cachedInput: 0.002,
          input: 0.1,
          output: 0.2,
        },
        reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      },
      "grok-4.5": {
        contextWindow: 500_000,
        defaultReasoningEffort: "high",
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          tiers: [
            {
              cachedInput: 0.5,
              input: 2,
              maxInputTokens: 200_000,
              output: 6,
            },
            {
              cachedInput: 1,
              input: 4,
              output: 12,
            },
          ],
        },
        reasoningEfforts: ["low", "medium", "high"],
      },
      "grok-4.6": {
        contextWindow: 500_000,
        defaultReasoningEffort: "high",
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          tiers: [
            {
              cachedInput: 0.5,
              input: 2,
              maxInputTokens: 200_000,
              output: 6,
            },
            {
              cachedInput: 1,
              input: 4,
              output: 12,
            },
          ],
        },
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
      "deepseek-v4.1-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 384_000,
        pricing: {
          cachedInput: 0.006,
          input: 0.3,
          offPeak: {
            cachedInput: 0.003,
            input: 0.15,
            output: 0.6,
          },
          output: 1.2,
          peakWindows: deepseekPeakWindows,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "deepseek-v4-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.006,
          input: 0.3,
          offPeak: {
            cachedInput: 0.003,
            input: 0.15,
            output: 0.6,
          },
          output: 1.2,
          peakWindows: deepseekPeakWindows,
        },
      },
      "deepseek-v4-flash-vision-exp": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 384_000,
        pricing: {
          cachedInput: 0.006,
          input: 0.3,
          offPeak: {
            cachedInput: 0.003,
            input: 0.15,
            output: 0.6,
          },
          output: 1.2,
          peakWindows: deepseekPeakWindows,
        },
        reasoningEfforts: ["low", "high", "max"],
      },
      "deepseek-v4-pro": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.044,
          input: 1.32,
          offPeak: {
            cachedInput: 0.022,
            input: 0.66,
            output: 1.98,
          },
          output: 3.96,
          peakWindows: deepseekPeakWindows,
        },
      },
      "kimi-k2.7-code": {
        contextWindow: 262_144,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.19,
          input: 0.95,
          output: 4,
        },
      },
      "kimi-k3": {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.3,
          input: 3,
          output: 15,
        },
      },
      "mimo-v2.5": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.0028,
          input: 0.14,
          output: 0.28,
        },
      },
      "mimo-v2.5-pro": {
        contextWindow: 1_048_576,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.0145,
          input: 1.74,
          output: 3.48,
        },
      },
      "qwen3.7-plus": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          tiers: [
            {
              cacheCreationInput: 0.5,
              cachedInput: 0.04,
              input: 0.4,
              maxInputTokens: 200_000,
              output: 1.6,
            },
            {
              cacheCreationInput: 1.5,
              cachedInput: 0.12,
              input: 1.2,
              maxInputTokens: 256_000,
              output: 4.8,
            },
          ],
        },
      },
      "qwen3.7-max": {
        contextWindow: 1_000_000,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cacheCreationInput: 3.125,
          cachedInput: 0.5,
          input: 2.5,
          output: 7.5,
        },
      },
      "qwen3.8-max": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cacheCreationInput: 2.5,
          cachedInput: 0.25,
          input: 2,
          output: 6,
        },
      },
      "qwen3.8-flash": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 131_072,
        pricing: {
          cacheCreationInput: 0.2,
          cachedInput: 0.016,
          input: 0.15,
          output: 0.47,
        },
        reasoningEfforts: ["low", "medium", "xhigh"],
      },
      "minimax-m2.7": {
        contextWindow: 204_800,
        inputModalities: ["text"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.06,
          input: 0.3,
          output: 1.2,
        },
      },
      "minimax-m3": {
        contextWindow: 1_000_000,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          tiers: [
            {
              cachedInput: 0.06,
              input: 0.3,
              maxInputTokens: 200_000,
              output: 1.2,
            },
            {
              cachedInput: 0.12,
              input: 0.6,
              maxInputTokens: 512_000,
              output: 2.4,
            },
          ],
        },
      },
    },
    kimi: {
      k3: {
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.3,
          input: 3,
          output: 15,
        },
      },
      "k3-256k": {
        contextWindow: 262_144,
        inputModalities: ["text", "image"],
        maxOutputTokens: 64_000,
        pricing: {
          cachedInput: 0.3,
          input: 3,
          output: 15,
        },
      },
    },
  }

  private readonly modelCatalog: BuiltinProviderModelCatalog

  constructor() {
    this.modelCatalog = BuiltinProviderModelRegistry.catalog
  }

  getModelConfig(
    providerName: string,
    modelName: string,
  ): BuiltinProviderModelConfig | undefined {
    const models = this.modelCatalog[this.normalizeKey(providerName)]
    return models?.[modelName.trim()] ?? models?.[this.normalizeKey(modelName)]
  }

  getModelIds(providerName: string): Array<string> {
    return Object.keys(this.modelCatalog[this.normalizeKey(providerName)] ?? {})
  }

  private normalizeKey(value: string): string {
    return value.trim().toLowerCase()
  }
}

export const builtinProviderModelRegistry = new BuiltinProviderModelRegistry()
