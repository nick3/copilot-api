import { describe, expect, test } from "bun:test"

import {
  builtinProviderModelRegistry,
  BuiltinProviderModelRegistry,
} from "~/lib/builtin-provider-models"
import {
  dashscopePeakWindows,
  deepseekPeakWindows,
} from "~/lib/token-usage/pricing"

describe("builtin provider model registry", () => {
  test("normalizes provider and model names when resolving model config", () => {
    expect(builtinProviderModelRegistry).toBeInstanceOf(
      BuiltinProviderModelRegistry,
    )
    expect(
      builtinProviderModelRegistry.getModelConfig(
        " DeepSeek ",
        " DEEPSEEK-V4-PRO ",
      ),
    ).toMatchObject({
      contextWindow: 1_000_000,
      inputModalities: ["text"],
      maxOutputTokens: 64_000,
      pricing: {
        cachedInput: 0.3,
        input: 9,
        output: 27,
      },
    })
  })

  test("lists model ids for a normalized provider name", () => {
    const modelIds = builtinProviderModelRegistry.getModelIds(" OPENCODE-GO ")
    for (const modelId of [
      "hy3",
      "gpt-5.6-luna",
      "qwen3.8-max",
      "minimax-m3",
      "glm-5.3-flash",
      "muse-spark-1.2-contributor",
      "hy4-preview",
      "qwen3.8-flash",
      "grok-4.6",
    ]) {
      expect(modelIds).toContain(modelId)
    }
  })

  test("does not keep Ox Alpha models in the catalog", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig(
        "opencode-go",
        "ox-alpha-free",
      ),
    ).toBeUndefined()
  })

  test("defines the Muse Spark 1.2 Contributor model pricing", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig(
        "opencode-go",
        "muse-spark-1.2-contributor",
      ),
    ).toEqual({
      contextWindow: 1_048_576,
      inputModalities: ["text", "image"],
      maxOutputTokens: 131_072,
      pricing: {
        cachedInput: 0.002,
        input: 0.1,
        output: 0.2,
      },
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    })
  })

  test("defines the GLM-5.3 Flash model pricing", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig(
        "opencode-go",
        "glm-5.3-flash",
      ),
    ).toEqual({
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      maxOutputTokens: 131_072,
      pricing: {
        cachedInput: 0.015,
        input: 0.075,
        output: 0.25,
      },
      reasoningEfforts: ["low", "high", "max"],
    })
  })

  test("defines the supported Grok reasoning levels", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig("opencode-go", "grok-4.5"),
    ).toMatchObject({
      defaultReasoningEffort: "high",
      reasoningEfforts: ["low", "medium", "high"],
    })
  })

  test("flags models that expect the OpenRouter-style reasoning field", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig("opencode-go", "hy3"),
    ).toMatchObject({
      reasoningField: "reasoning",
    })
    expect(
      builtinProviderModelRegistry.getModelConfig("opencode-go", "hy4-preview"),
    ).toMatchObject({
      reasoningField: "reasoning",
    })
  })

  test("keeps GPT entries pricing-only", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig("codex", "gpt-5.6-sol"),
    ).toEqual({
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
    })
  })

  test("returns empty results for unknown providers and models", () => {
    expect(builtinProviderModelRegistry.getModelIds("unknown")).toEqual([])
    expect(
      builtinProviderModelRegistry.getModelConfig("deepseek", "unknown"),
    ).toBeUndefined()
  })

  test("defines DeepSeek peak and off-peak pricing with the DeepSeek windows", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig("deepseek", "deepseek-flash"),
    ).toEqual({
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
    })

    expect(
      builtinProviderModelRegistry.getModelConfig(
        "deepseek",
        "deepseek-v4-pro",
      ),
    ).toMatchObject({
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
    })
  })

  test("defines the DashScope DeepSeek V4.1 Flash model with DashScope windows", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig(
        "dashscope",
        "deepseek-v4.1-flash",
      ),
    ).toEqual({
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
    })

    expect(
      builtinProviderModelRegistry.getModelConfig(
        "dashscope",
        "deepseek-v4-flash-0731",
      ),
    ).toMatchObject({
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
    })
  })

  test("applies the DeepSeek windows to every OpenCode Go DeepSeek model", () => {
    const expectedPricing = {
      "deepseek-v4-flash": {
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
      "deepseek-v4-flash-vision-exp": {
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
      "deepseek-v4-pro": {
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
      "deepseek-v4.1-flash": {
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
    }

    for (const [model, pricing] of Object.entries(expectedPricing)) {
      expect(
        builtinProviderModelRegistry.getModelConfig("opencode-go", model)
          ?.pricing,
      ).toEqual(pricing)
    }
  })
})
