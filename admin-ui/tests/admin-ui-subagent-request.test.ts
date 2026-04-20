import { expect, test } from "bun:test"

import { normalizeAdminRequestItem } from "../src/lib/admin-api"

test("normalizeAdminRequestItem converts wire is_subagent values into UI semantics", () => {
  expect(normalizeAdminRequestItem({ request_id: "r1", http_status: 200, path: "/v1/messages", is_subagent: 1 }).is_subagent).toBe(true)
  expect(normalizeAdminRequestItem({ request_id: "r2", http_status: 200, path: "/v1/messages", is_subagent: 0 }).is_subagent).toBe(false)
  expect(normalizeAdminRequestItem({ request_id: "r3", http_status: 200, path: "/v1/messages", is_subagent: null }).is_subagent).toBeNull()
  expect(normalizeAdminRequestItem({ request_id: "r4", http_status: 200, path: "/v1/messages" }).is_subagent).toBeNull()
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
