import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  ResponsesApiSettingsCard,
  compactThresholdRecordFromItems,
  createQuickProviderItem,
  deriveProviderModelSuggestions,
  getUniqueProviderName,
  parseCompactThresholdsJson,
} from "../src/pages/settings-page"

test("Responses API settings exposes transport toggles and context management", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement
      useResponsesApiWebSearch
      useResponsesApiWebSocket={false}
      messageApiWebSearchModelValue="search/gpt-search"
      responsesApiContextManagementModelsValue=""
      compactThresholdsMode="form"
      compactThresholdsJson="{}"
      compactThresholdsJsonIssue={null}
      compactThresholdsItems={[]}
      models={[]}
      onCompactThresholdsAddItem={() => {}}
      onCompactThresholdsJsonChange={() => {}}
      onCompactThresholdsRemoveItem={() => {}}
      onCompactThresholdsToggleMode={() => {}}
      onCompactThresholdsUpdateItem={() => {}}
      onMessageApiWebSearchModelChange={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Enable Responses API WebSocket")
  expect(html).toContain("ws:/responses")
  expect(html).toContain("Messages web search model")
  expect(html).toContain("search/gpt-search")
  expect(html).toContain("Enable Responses API context management")
  expect(html).toContain("Default: enabled")
  expect(html).toContain("Legacy context management models")
  expect(html).toContain('aria-checked="false"')
})

test("Responses API settings marks dependent fields inactive when context management is off", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement={false}
      useResponsesApiWebSearch
      useResponsesApiWebSocket
      messageApiWebSearchModelValue="gpt-5-mini"
      responsesApiContextManagementModelsValue="gpt-5.4"
      compactThresholdsMode="form"
      compactThresholdsJson="{}"
      compactThresholdsJsonIssue={null}
      compactThresholdsItems={[]}
      models={[]}
      onCompactThresholdsAddItem={() => {}}
      onCompactThresholdsJsonChange={() => {}}
      onCompactThresholdsRemoveItem={() => {}}
      onCompactThresholdsToggleMode={() => {}}
      onCompactThresholdsUpdateItem={() => {}}
      onMessageApiWebSearchModelChange={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Context management is disabled")
  expect(html).toContain("Compact threshold overrides are saved")
  expect(html).toContain("gpt-5.4")
})

test("compact threshold form validation rejects decimals", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement
      useResponsesApiWebSearch
      useResponsesApiWebSocket
      messageApiWebSearchModelValue="gpt-5-mini"
      responsesApiContextManagementModelsValue=""
      compactThresholdsMode="form"
      compactThresholdsJson="{}"
      compactThresholdsJsonIssue={null}
      compactThresholdsItems={[
        {
          id: "threshold-1",
          model: "gpt-5.4",
          threshold: "1.5",
        },
      ]}
      models={["gpt-5.4"]}
      onCompactThresholdsAddItem={() => {}}
      onCompactThresholdsJsonChange={() => {}}
      onCompactThresholdsRemoveItem={() => {}}
      onCompactThresholdsToggleMode={() => {}}
      onCompactThresholdsUpdateItem={() => {}}
      onMessageApiWebSearchModelChange={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Threshold must be a positive integer.")
})

test("provider model suggestions are derived from configured providers", () => {
  const suggestions = deriveProviderModelSuggestions([
    {
      name: "openrouter",
      models: [{ model: "anthropic/claude-sonnet-4" }, { model: "" }],
    },
    {
      name: " ",
      models: [{ model: "ignored" }],
    },
    {
      name: "deepseek",
      models: [{ model: "deepseek-chat" }, { model: "deepseek-chat" }],
    },
  ])

  expect(suggestions).toEqual([
    "openrouter/anthropic/claude-sonnet-4",
    "deepseek/deepseek-chat",
  ])
})

test("Messages web search model renders Copilot and provider suggestions", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement
      useResponsesApiWebSearch
      useResponsesApiWebSocket
      messageApiWebSearchModelValue="gpt-5-mini"
      responsesApiContextManagementModelsValue=""
      compactThresholdsMode="form"
      compactThresholdsJson="{}"
      compactThresholdsJsonIssue={null}
      compactThresholdsItems={[]}
      models={["gpt-5-mini", "gpt-5.4"]}
      providerModelSuggestions={["openrouter/anthropic/claude-sonnet-4"]}
      onCompactThresholdsAddItem={() => {}}
      onCompactThresholdsJsonChange={() => {}}
      onCompactThresholdsRemoveItem={() => {}}
      onCompactThresholdsToggleMode={() => {}}
      onCompactThresholdsUpdateItem={() => {}}
      onMessageApiWebSearchModelChange={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Copilot model suggestions")
  expect(html).toContain("gpt-5-mini")
  expect(html).toContain("Configured provider/model suggestions")
  expect(html).toContain("openrouter/anthropic/claude-sonnet-4")
  expect(html).toContain("Suggestions are candidates only")
})

test("Messages web search model keeps custom values visible", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement
      useResponsesApiWebSearch
      useResponsesApiWebSocket
      messageApiWebSearchModelValue="custom-search-model"
      responsesApiContextManagementModelsValue=""
      compactThresholdsMode="form"
      compactThresholdsJson="{}"
      compactThresholdsJsonIssue={null}
      compactThresholdsItems={[]}
      models={["gpt-5-mini"]}
      providerModelSuggestions={["openrouter/anthropic/claude-sonnet-4"]}
      onCompactThresholdsAddItem={() => {}}
      onCompactThresholdsJsonChange={() => {}}
      onCompactThresholdsRemoveItem={() => {}}
      onCompactThresholdsToggleMode={() => {}}
      onCompactThresholdsUpdateItem={() => {}}
      onMessageApiWebSearchModelChange={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("custom-search-model")
  expect(html).toContain("Custom value accepted: custom-search-model")
})

test("Messages web search model input can stay empty", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement
      useResponsesApiWebSearch
      useResponsesApiWebSocket
      messageApiWebSearchModelValue=""
      responsesApiContextManagementModelsValue=""
      compactThresholdsMode="form"
      compactThresholdsJson="{}"
      compactThresholdsJsonIssue={null}
      compactThresholdsItems={[]}
      models={[]}
      onCompactThresholdsAddItem={() => {}}
      onCompactThresholdsJsonChange={() => {}}
      onCompactThresholdsRemoveItem={() => {}}
      onCompactThresholdsToggleMode={() => {}}
      onCompactThresholdsUpdateItem={() => {}}
      onMessageApiWebSearchModelChange={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Messages web search model")
  expect(html).toContain('value=""')
})

test("compact threshold JSON validation rejects decimals", () => {
  const result = parseCompactThresholdsJson('{ "gpt-5.4": 1.5 }')

  expect(result).toEqual({
    error: "modelResponsesApiCompactThresholds.gpt-5.4 must be a positive integer.",
  })
})

test("compact threshold form record skips decimals", () => {
  const record = compactThresholdRecordFromItems([
    { id: "threshold-1", model: "gpt-5.4", threshold: "1.5" },
    { id: "threshold-2", model: "gpt-5.5", threshold: "2" },
  ])

  expect(record).toEqual({ "gpt-5.5": 2 })
})

test("provider quick add generates unique provider names", () => {
  const name = getUniqueProviderName("deepseek", [
    { name: "deepseek" },
    { name: "deepseek-2" },
    { name: "OpenRouter" },
  ])

  expect(name).toBe("deepseek-3")
})

test("provider quick add maps presets to safe defaults", () => {
  const deepseek = createQuickProviderItem("deepseek", [])
  const dashscope = createQuickProviderItem("dashscope", [])
  const openrouter = createQuickProviderItem("openrouter", [])
  const custom = createQuickProviderItem("custom", [])

  expect(deepseek).toMatchObject({
    name: "deepseek",
    type: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    pricingCurrency: "CNY",
    authType: "x-api-key",
    enabled: true,
    apiKey: "",
    adjustInputTokens: false,
    models: [],
  })
  expect(dashscope).toMatchObject({
    name: "dashscope",
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    pricingCurrency: "CNY",
    authType: "x-api-key",
    enabled: true,
  })
  expect(openrouter).toMatchObject({
    name: "openrouter",
    type: "anthropic",
    baseUrl: "https://openrouter.ai/api",
    pricingCurrency: "USD",
    authType: "x-api-key",
    enabled: true,
  })
  expect(custom).toMatchObject({
    name: "",
    type: "anthropic",
    baseUrl: "",
    pricingCurrency: "",
    authType: "x-api-key",
    enabled: true,
    apiKey: "",
    adjustInputTokens: false,
    models: [],
  })
})
