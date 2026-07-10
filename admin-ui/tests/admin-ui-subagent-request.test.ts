import { expect, test } from "bun:test"

import {
  normalizeAdminModelDetailsItem,
  normalizeAdminRequestItem,
} from "../src/lib/admin-api"
import { getAccountCreditsSummary } from "../src/lib/account-credits"
import { isBillableModel } from "../src/lib/model-billing"
import { formatRequestCreditsRemaining } from "../src/lib/request-credits"

test("normalizeAdminRequestItem converts wire is_subagent values into UI semantics", () => {
  expect(normalizeAdminRequestItem({ request_id: "r1", http_status: 200, path: "/v1/messages", is_subagent: 1 }).is_subagent).toBe(true)
  expect(normalizeAdminRequestItem({ request_id: "r2", http_status: 200, path: "/v1/messages", is_subagent: 0 }).is_subagent).toBe(false)
  expect(normalizeAdminRequestItem({ request_id: "r3", http_status: 200, path: "/v1/messages", is_subagent: null }).is_subagent).toBeNull()
  expect(normalizeAdminRequestItem({ request_id: "r4", http_status: 200, path: "/v1/messages" }).is_subagent).toBeNull()
})

test("normalizeAdminRequestItem exposes AI Credits fields with legacy fallback", () => {
  expect(
    normalizeAdminRequestItem({
      request_id: "r-credits",
      http_status: 200,
      path: "/v1/messages",
      credits_consumed: 3,
      credits_remaining_after: 97,
      credits_unlimited_after: false,
    }).credits_consumed,
  ).toBe(3)

  const legacy = normalizeAdminRequestItem({
    request_id: "r-legacy",
    http_status: 200,
    path: "/v1/messages",
    cost_units: 2,
    premium_remaining_before: 100,
    premium_remaining_after: 98,
    premium_remaining_diff: -2,
    premium_unlimited_after: 0,
  })

  expect(legacy.credits_consumed).toBe(2)
  expect(legacy.credits_remaining_before).toBe(100)
  expect(legacy.credits_remaining_after).toBe(98)
  expect(legacy.credits_remaining_diff).toBe(-2)
  expect(legacy.credits_unlimited_after).toBe(false)
  expect(typeof legacy.credits_unlimited_after).toBe("boolean")
})

test("formatRequestCreditsRemaining prefers unlimited before numeric remaining", () => {
  expect(
    formatRequestCreditsRemaining({
      credits_unlimited_after: true,
      credits_remaining_after: 97,
    }),
  ).toBe("∞")

  expect(
    formatRequestCreditsRemaining({
      credits_unlimited_after: false,
      credits_remaining_after: 97,
    }),
  ).toBe("97")

  expect(
    formatRequestCreditsRemaining({
      credits_unlimited_after: null,
      credits_remaining_after: undefined,
    }),
  ).toBe("")
})

test("normalizeAdminModelDetailsItem does not infer token billing from legacy premium billing", () => {
  const normalized = normalizeAdminModelDetailsItem({
    id: "gpt-5-mini",
    name: "gpt-5-mini",
    preview: false,
    billing: {
      is_premium: true,
      multiplier: 2,
    },
    supported_endpoints: ["/responses"],
    capabilities: {
      limits: {},
      supports: {},
    },
    aliases: [],
  })

  expect(normalized.billing?.tokenBasedBilling).toBeUndefined()
})

test("normalizeAdminModelDetailsItem treats token prices as billable", () => {
  const normalized = normalizeAdminModelDetailsItem({
    id: "gpt-5-token-priced",
    name: "gpt-5-token-priced",
    preview: false,
    billing: {
      is_premium: false,
      token_prices: {
        batch_size: 1_000_000,
        cache_price: 50_000_000_000,
        input_price: 500_000_000_000,
        output_price: 3_000_000_000_000,
      },
    },
    supported_endpoints: ["/responses"],
    capabilities: {
      limits: {},
      supports: {},
    },
    aliases: [],
  })

  expect(normalized.billing?.tokenBasedBilling).toBe(true)
})

test("normalizeAdminModelDetailsItem treats tiered token prices as billable", () => {
  const normalized = normalizeAdminModelDetailsItem({
    id: "gpt-5-tiered-token-priced",
    name: "gpt-5-tiered-token-priced",
    preview: false,
    billing: {
      is_premium: false,
      token_prices: {
        batch_size: 1_000_000,
        default: {
          cache_price: 50,
          input_price: 500,
          output_price: 3_000,
        },
      },
    },
    supported_endpoints: ["/responses"],
    capabilities: {
      limits: {},
      supports: {},
    },
    aliases: [],
  })

  expect(normalized.billing?.tokenBasedBilling).toBe(true)
})

test("normalizeAdminModelDetailsItem ignores empty token prices", () => {
  const normalized = normalizeAdminModelDetailsItem({
    id: "gpt-5-empty-prices",
    name: "gpt-5-empty-prices",
    preview: false,
    billing: {
      is_premium: true,
      token_prices: {},
    },
    supported_endpoints: ["/responses"],
    capabilities: {
      limits: {},
      supports: {},
    },
    aliases: [],
  })

  expect(normalized.billing?.tokenBasedBilling).toBeUndefined()
})

test("models page treats legacy premium billing as billable", () => {
  expect(
    isBillableModel({
      billing: {
        is_premium: true,
      },
    }),
  ).toBe(true)
})

test("accounts KPI summary ignores missing remaining values", () => {
  expect(
    getAccountCreditsSummary({
      account_id: "missing-remaining",
      runtime: {
        creditsEntitlement: 100,
      },
    }).used,
  ).toBeUndefined()
})

test("request detail upstream header rows include outbound x-interaction-id", async () => {
  const mod = await import("../src/pages/request-detail-page")
  const buildRows = (mod as Record<string, unknown>).buildRequestDetailUpstreamHeaderRows

  expect(typeof buildRows).toBe("function")

  const rows = (buildRows as (item: Record<string, unknown>) => Array<{
    labelKey: string
    tooltipKey: string
    value: string
  }> )({
    request_id: "r1",
    http_status: 200,
    path: "/v1/messages",
    outbound_x_request_id: "upstream-req-1",
    outbound_x_agent_task_id: "agent-task-1",
    outbound_x_interaction_id: "interaction-1",
    outbound_x_interaction_type: "conversation-agent",
    outbound_openai_intent: "messages-proxy",
    outbound_user_agent: "Claude-Code-Test",
  })

  const interactionIdRow = rows.find(
    (row) => row.labelKey === "requestDetailPage.fields.outboundXInteractionId",
  )

  expect(interactionIdRow?.tooltipKey).toBe(
    "requestDetailPage.fieldTooltip.outboundXInteractionId",
  )
  expect(interactionIdRow?.value).toBe("interaction-1")
})
