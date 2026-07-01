import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  ModelMappingsCard,
  ReasoningEffortsCard,
  ResponsesApiSettingsCard,
  compactThresholdRecordFromItems,
  createQuickProviderItem,
  deriveReasoningSupportByModel,
  deriveProviderModelSuggestions,
  getUniqueProviderName,
  parseCompactThresholdsJson,
  parseModelMappingsJson,
  parseReasoningJson,
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

test("reasoning editor renders model-specific effort choices", () => {
  const html = renderToStaticMarkup(
    <ReasoningEffortsCard
      mode="form"
      json="{}"
      jsonIssue={null}
      items={[{ id: "reasoning-1", model: "gpt-5-mini", effort: "low" }]}
      models={["gpt-5-mini"]}
      reasoningSupportByModel={{
        "gpt-5-mini": {
          efforts: ["low", "medium"],
        },
      }}
      onToggleMode={() => {}}
      onJsonChange={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
      onUpdateItem={() => {}}
    />,
  )

  expect(html).toContain("gpt-5-mini")
  expect(html).toContain("low")
  expect(html).toContain("medium")
  expect(html).not.toContain("xhigh")
})

test("reasoning editor shows alias support inherited from target", () => {
  const html = renderToStaticMarkup(
    <ReasoningEffortsCard
      mode="form"
      json="{}"
      jsonIssue={null}
      items={[{ id: "reasoning-1", model: "fast", effort: "xhigh" }]}
      models={["fast"]}
      reasoningSupportByModel={{
        fast: {
          efforts: ["high", "xhigh"],
          target: "gpt-5.4",
        },
      }}
      onToggleMode={() => {}}
      onJsonChange={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
      onUpdateItem={() => {}}
    />,
  )

  expect(html).toContain("fast")
  expect(html).toContain("gpt-5.4")
  expect(html).toContain("high")
  expect(html).toContain("xhigh")
})

test("reasoning editor disables effort choices when loaded metadata lacks model support", () => {
  const html = renderToStaticMarkup(
    <ReasoningEffortsCard
      mode="form"
      json="{}"
      jsonIssue={null}
      items={[{ id: "reasoning-1", model: "gemini-lite", effort: "medium" }]}
      models={["gemini-lite"]}
      reasoningSupportByModel={{}}
      reasoningSupportLoaded
      onToggleMode={() => {}}
      onJsonChange={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
      onUpdateItem={() => {}}
    />,
  )

  expect(html).toContain('data-reasoning-effort-disabled="true"')
  expect(html).toContain('data-reasoning-effort-options="medium"')
  expect(html).toContain("No reasoning effort metadata")
  expect(html).not.toContain("xhigh")
})

test("reasoning editor falls back without row warnings when metadata fails to load", () => {
  const html = renderToStaticMarkup(
    <ReasoningEffortsCard
      mode="form"
      json="{}"
      jsonIssue={null}
      items={[{ id: "reasoning-1", model: "gemini-lite", effort: "medium" }]}
      models={["gemini-lite"]}
      reasoningSupportByModel={{}}
      reasoningSupportLoaded={false}
      onToggleMode={() => {}}
      onJsonChange={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
      onUpdateItem={() => {}}
    />,
  )

  expect(html).not.toContain("No reasoning effort metadata")
  expect(html).not.toContain('data-reasoning-effort-disabled="true"')
  expect(html).toContain("xhigh")
})

test("reasoning JSON validation accepts max", () => {
  expect(parseReasoningJson('{ "gpt-5.5": "max" }')).toEqual({
    record: {
      "gpt-5.5": "max",
    },
  })
})

test("reasoning support derivation includes aliases and ignores unknown efforts", () => {
  expect(
    deriveReasoningSupportByModel([
      {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        preview: false,
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          limits: {},
          supports: {
            reasoning_effort: ["low", "medium", "ultra", "xhigh"],
          },
        },
        aliases: ["fast"],
      },
    ]),
  ).toEqual({
    "gpt-5-mini": { efforts: ["low", "medium", "xhigh"] },
    fast: { efforts: ["low", "medium", "xhigh"], target: "gpt-5-mini" },
  })
})

test("model mappings card renders mappings editor", () => {
  const html = renderToStaticMarkup(
    <ModelMappingsCard
      mode="form"
      json="{}"
      jsonIssue={null}
      items={[
        {
          id: "mapping-1",
          source: "gpt-client",
          target: "provider/gpt-target",
        },
      ]}
      onAddItem={() => {}}
      onJsonChange={() => {}}
      onRemoveItem={() => {}}
      onToggleMode={() => {}}
      onUpdateItem={() => {}}
    />,
  )

  expect(html).toContain("Model mappings")
  expect(html).toContain("gpt-client")
  expect(html).toContain("provider/gpt-target")
  expect(html).toContain("Add mapping")
})

test("model mappings JSON validation rejects invalid shapes", () => {
  expect(parseModelMappingsJson("[]")).toEqual({
    error: "modelMappings JSON must be an object.",
  })
  expect(parseModelMappingsJson('{ "gpt-client": "" }')).toEqual({
    error: "modelMappings.gpt-client must be a non-empty string.",
  })
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
  const openCodeGo = createQuickProviderItem("opencode-go", [])
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
  expect(openCodeGo).toMatchObject({
    name: "opencode-go",
    type: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go",
    pricingCurrency: "USD",
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
