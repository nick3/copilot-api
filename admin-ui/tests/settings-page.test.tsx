import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AdvancedSettingsCard } from "../src/pages/settings-page"

test("Advanced settings exposes Responses API WebSocket toggle", () => {
  const html = renderToStaticMarkup(
    <AdvancedSettingsCard
      accountAffinityEnabled
      allowOriginalModelNamesForAliases={false}
      compactUseSmallModel={false}
      forceAgent={false}
      messageStartInputTokensFallback={false}
      modelRefreshIntervalInput=""
      modelRefreshIntervalIssue={null}
      responsesApiContextManagementModelsValue=""
      sessionAffinityRetentionInput=""
      sessionAffinityRetentionIssue={null}
      useMessagesApi
      useResponsesApiWebSearch
      useResponsesApiWebSocket={false}
      onModelRefreshIntervalChange={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onSessionAffinityRetentionChange={() => {}}
      onToggleAccountAffinity={() => {}}
      onToggleAllowOriginalModelNamesForAliases={() => {}}
      onToggleCompactUseSmallModel={() => {}}
      onToggleForceAgent={() => {}}
      onToggleMessageStartInputTokensFallback={() => {}}
      onToggleUseMessagesApi={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Enable Responses API WebSocket")
  expect(html).toContain("ws:/responses")
  expect(html).toContain('aria-checked="false"')
})
