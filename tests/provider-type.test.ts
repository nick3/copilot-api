import { describe, expect, test } from "bun:test"

import {
  resolveEffectiveProviderType,
  type ResolvedProviderConfig,
} from "../src/lib/config"

const createProviderConfig = (
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig => ({
  apiKey: "provider-key",
  authType: "authorization",
  baseUrl: "https://opencode.example/zen/go",
  name: "opencode-go",
  type: "openai-compatible",
  ...overrides,
})

describe("effective provider type", () => {
  test("uses Anthropic for OpenCode Go Qwen and MiniMax models", () => {
    const providerConfig = createProviderConfig()

    expect(resolveEffectiveProviderType(providerConfig, "qwen3.8-max")).toBe(
      "anthropic",
    )
    expect(resolveEffectiveProviderType(providerConfig, "MiniMax-M3")).toBe(
      "anthropic",
    )
  })

  test("uses OpenAI Responses for OpenCode Go GPT models", () => {
    expect(
      resolveEffectiveProviderType(createProviderConfig(), "gpt-5.6-luna"),
    ).toBe("openai-responses")
  })

  test("keeps OpenCode Go's OpenAI-compatible default for other models", () => {
    const providerConfig = createProviderConfig()

    expect(resolveEffectiveProviderType(providerConfig, "glm-5.2")).toBe(
      "openai-compatible",
    )
    expect(resolveEffectiveProviderType(providerConfig, "gptfoo")).toBe(
      "openai-compatible",
    )
  })

  test("does not apply OpenCode Go rules to other providers", () => {
    expect(
      resolveEffectiveProviderType(
        createProviderConfig({ name: "custom" }),
        "qwen3.8-max",
      ),
    ).toBe("openai-compatible")
  })

  test("keeps an explicit model type override ahead of built-in rules", () => {
    expect(
      resolveEffectiveProviderType(
        createProviderConfig({
          models: {
            "qwen3.8-max": { type: "openai-compatible" },
          },
        }),
        "qwen3.8-max",
      ),
    ).toBe("openai-compatible")
  })
})
