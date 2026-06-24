import type { ProviderType } from "./config"

interface QuickProviderConfig {
  type: ProviderType
  baseUrl: string
  pricingCurrency: string
  editableType: boolean
}

export const QUICK_PROVIDER_CONFIGS = {
  deepseek: {
    type: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    pricingCurrency: "CNY",
    editableType: true,
  },
  dashscope: {
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    pricingCurrency: "CNY",
    editableType: true,
  },
  openrouter: {
    type: "anthropic",
    baseUrl: "https://openrouter.ai/api",
    pricingCurrency: "USD",
    editableType: false,
  },
} satisfies Record<string, QuickProviderConfig>

export type QuickProviderName = keyof typeof QUICK_PROVIDER_CONFIGS
