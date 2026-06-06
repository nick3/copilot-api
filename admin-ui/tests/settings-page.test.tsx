import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { ResponsesApiSettingsCard } from "../src/pages/settings-page"

test("Responses API settings exposes transport toggles and context management", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement
      useResponsesApiWebSearch
      useResponsesApiWebSocket={false}
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
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Enable Responses API WebSocket")
  expect(html).toContain("ws:/responses")
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
