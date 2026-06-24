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
})
