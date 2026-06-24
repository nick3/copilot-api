import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AggregatedModelsPreviewCard } from "../src/pages/models-page"

test("aggregated models preview renders read-only /v1/models rows", () => {
  const html = renderToStaticMarkup(
    <AggregatedModelsPreviewCard
      loading={false}
      error={null}
      models={[
        {
          id: "gpt-5-mini",
          object: "model",
          type: "model",
          owned_by: "openai",
          display_name: "GPT-5 mini",
          claude_model_id: "gpt-5-mini",
        },
        {
          id: "dash/qwen-plus",
          object: "model",
          owned_by: "dash",
          display_name: "qwen-plus",
        },
      ]}
      onRetry={() => {}}
    />,
  )

  expect(html).toContain("Aggregated /v1/models preview")
  expect(html).toContain("read-only")
  expect(html).toContain("gpt-5-mini")
  expect(html).toContain("dash/qwen-plus")
})
