import { describe, expect, test } from "bun:test"

import { QUICK_PROVIDER_CONFIGS } from "../src/lib/quick-providers"

describe("quick provider configs", () => {
  test("uses Anthropic defaults for DeepSeek", () => {
    expect(QUICK_PROVIDER_CONFIGS.deepseek).toEqual({
      baseUrl: "https://api.deepseek.com/anthropic",
      editableType: true,
      pricingCurrency: "CNY",
      type: "anthropic",
    })
  })

  test("uses OpenAI-compatible defaults for OpenCode Go", () => {
    expect(QUICK_PROVIDER_CONFIGS["opencode-go"]).toEqual({
      baseUrl: "https://opencode.ai/zen/go",
      editableType: false,
      pricingCurrency: "USD",
      type: "openai-compatible",
    })
  })
})
