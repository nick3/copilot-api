import { expect, mock, test } from "bun:test"

import type { AccountContext } from "../src/lib/types/account"
import type {
  AnthropicMessagesPayload,
  AnthropicUserMessage,
} from "../src/routes/messages/anthropic-types"

import { COMPACT_REQUEST } from "../src/lib/compact"
import { requestContext } from "../src/lib/request-context"
import { createMessages } from "../src/services/copilot/create-messages"

type FetchOpts = {
  headers: Record<string, string>
  body?: string
}

const accountContext: AccountContext = {
  githubToken: "test-github-token",
  copilotToken: "test-copilot-token",
  accountType: "individual",
  vsCodeVersion: "1.0.0",
}

const fetchMock = mock((_url: string, opts: FetchOpts) => {
  return {
    ok: true,
    json: () => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
      model: "copilot/gpt-5.2",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    }),
    headers: opts.headers,
  }
})

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

const basePayload = (
  content: AnthropicUserMessage["content"],
): AnthropicMessagesPayload => ({
  model: "copilot/gpt-5.2",
  max_tokens: 64,
  messages: [{ role: "user", content }],
})

function getLastHeaders(): Record<string, string> {
  const lastCall = fetchMock.mock.calls.at(-1)
  expect(lastCall).toBeTruthy()
  if (!lastCall) {
    throw new Error("Expected fetch to be called at least once")
  }

  return lastCall[1].headers
}

test("respects explicit initiator override", async () => {
  const payload = basePayload([{ type: "text", text: "hello" }])

  await createMessages(payload, accountContext, {
    initiator: "agent",
  })

  expect(getLastHeaders()["x-initiator"]).toBe("agent")
})

test("falls back to user initiator for regular user prompt", async () => {
  const payload = basePayload([{ type: "text", text: "hello" }])

  await createMessages(payload, accountContext)

  expect(getLastHeaders()["x-initiator"]).toBe("user")
})

test("falls back to agent initiator for pure tool_result continuation", async () => {
  const payload = basePayload([
    {
      type: "tool_result",
      tool_use_id: "tool_1",
      content: "ok",
    },
  ])

  await createMessages(payload, accountContext)

  expect(getLastHeaders()["x-initiator"]).toBe("agent")
})

test("sets interaction headers for subagent session", async () => {
  const payload = basePayload([{ type: "text", text: "hello" }])

  await createMessages(payload, accountContext, {
    upstreamRequestId: "request-2",
    sessionId: "session-2",
    subagentMarker: {
      agent_id: "agent-2",
      agent_type: "opencode-subagent",
      session_id: "session-2",
    },
  })

  const headers = getLastHeaders()
  expect(headers["x-request-id"]).toBe("request-2")
  expect(headers["x-agent-task-id"]).toBe("request-2")
  expect(headers["x-interaction-id"]).toBe("session-2")
  expect(headers["x-interaction-type"]).toBe("conversation-subagent")
  expect(headers["x-initiator"]).toBe("agent")
})

test("keeps subagent interaction type for compact subagent requests", async () => {
  const payload = basePayload([{ type: "text", text: "hello" }])

  await createMessages(payload, accountContext, {
    upstreamRequestId: "request-compact-subagent",
    sessionId: "session-compact-subagent",
    subagentMarker: {
      agent_id: "agent-compact-subagent",
      agent_type: "opencode-subagent",
      session_id: "session-compact-subagent",
    },
    compactType: COMPACT_REQUEST,
  })

  const headers = getLastHeaders()
  expect(headers["x-request-id"]).toBe("request-compact-subagent")
  expect(headers["x-agent-task-id"]).toBe("request-compact-subagent")
  expect(headers["x-interaction-id"]).toBe("session-compact-subagent")
  expect(headers["x-interaction-type"]).toBe("conversation-subagent")
  expect(headers["x-initiator"]).toBe("agent")
})

test("forces agent initiator for compact requests", async () => {
  const payload = basePayload([{ type: "text", text: "hello" }])

  await createMessages(payload, accountContext, {
    compactType: COMPACT_REQUEST,
  })

  expect(getLastHeaders()["x-initiator"]).toBe("agent")
})

test("drops interleaved thinking beta for adaptive thinking requests", async () => {
  const payload = {
    ...basePayload([{ type: "text", text: "hello" }]),
    thinking: {
      type: "adaptive",
    },
  } satisfies AnthropicMessagesPayload

  await createMessages(payload, accountContext, {
    anthropicBetaHeader:
      "interleaved-thinking-2025-05-14,context-management-2025-06-27",
  })

  const anthropicBeta = getLastHeaders()["anthropic-beta"]
  expect(anthropicBeta).toBeTruthy()

  const betas = anthropicBeta.split(",").map((item) => item.trim())

  expect(betas).toContain("context-management-2025-06-27")
  expect(betas).not.toContain("interleaved-thinking-2025-05-14")
  expect(betas).not.toContain("advanced-tool-use-2025-11-20")
})

test("enables vision headers for images nested inside tool results", async () => {
  const payload = basePayload([
    {
      type: "tool_result",
      tool_use_id: "tool_vision",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "ZmFrZQ==",
          },
        },
      ],
    },
  ])

  await createMessages(payload, accountContext)

  expect(getLastHeaders()["copilot-vision-request"]).toBe("true")
})

test("captures final outbound headers after messages-proxy overrides", async () => {
  const payload = {
    ...basePayload([{ type: "text", text: "hello" }]),
    metadata: {
      user_id: "user_safety123_account_session_session-123",
    },
  } satisfies AnthropicMessagesPayload

  await requestContext.run(
    {
      traceId: "trace-1",
      startTime: Date.now(),
      userAgent: "Claude-Code-Test",
      sessionAffinity: undefined,
      parentSessionId: undefined,
    },
    async () => {
      await createMessages(payload, accountContext, {
        upstreamRequestId: "request-original",
      })

      const outboundHeaders = requestContext.getStore()?.outboundHeaders

      expect(outboundHeaders?.xRequestId).toBeDefined()
      expect(outboundHeaders?.xRequestId).not.toBe("request-original")
      expect(outboundHeaders?.xAgentTaskId).toBe(outboundHeaders?.xRequestId)
      expect(outboundHeaders?.xInteractionType).toBe("messages-proxy")
      expect(outboundHeaders?.openaiIntent).toBe("messages-proxy")
      expect(outboundHeaders?.userAgent).toBe(
        "vscode_claude_code/2.1.112 (external, sdk-ts, agent-sdk/0.2.112)",
      )
    },
  )
})
