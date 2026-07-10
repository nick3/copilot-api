import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { AdminModelDetailsItem } from "../src/lib/admin-api"

import { TooltipProvider } from "../src/components/ui/tooltip"
import {
  AggregatedModelsPreviewCard,
  ModelBillingCell,
} from "../src/pages/models-page"

function renderModelBillingCell(
  billing: AdminModelDetailsItem["billing"],
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ModelBillingCell billing={billing} />
    </TooltipProvider>,
  )
}

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

test("model billing cell renders tiered AI Credit prices", () => {
  const html = renderModelBillingCell({
    token_prices: {
      batch_size: 1_000_000,
      default: {
        cache_price: 50,
        input_price: 500,
        output_price: 2_500,
      },
    },
  })

  expect(html).toContain(">500<")
  expect(html).toContain(">50<")
  expect(html).toContain(">2,500<")
  expect(html).not.toContain(">—<")
})

test("model billing cell renders distinct long-context pricing", () => {
  const html = renderModelBillingCell({
    token_prices: {
      batch_size: 1_000_000,
      default: {
        cache_price: 20,
        context_max: 200_000,
        input_price: 200,
        output_price: 1_200,
      },
      long_context: {
        cache_price: 40,
        context_max: 936_000,
        input_price: 400,
        output_price: 1_800,
      },
    },
  })

  expect(html).toContain("Default")
  expect(html).toContain("Long context")
  expect(html).toContain("200,000")
  expect(html).toContain(">200<")
  expect(html).toContain(">20<")
  expect(html).toContain(">1,200<")
  expect(html).toContain(">400<")
  expect(html).toContain(">40<")
  expect(html).toContain(">1,800<")
  expect(html).not.toContain(">—<")
})

test("model billing cell labels a long-context-only price tier", () => {
  const html = renderModelBillingCell({
    token_prices: {
      batch_size: 1_000_000,
      long_context: {
        cache_price: 40,
        input_price: 400,
        output_price: 1_800,
      },
    },
  })

  expect(html).toContain("Long context")
  expect(html).toContain(">400<")
})
