import { expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import {
  createResponses,
  type ResponsesPayload,
} from "../src/services/copilot/create-responses"

type FetchOpts = {
  headers: Record<string, string>
  body?: string
}

state.githubToken = "test-github-token"
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock((_url: string, opts: FetchOpts) => {
  return {
    ok: true,
    json: () => ({
      id: "resp_1",
      object: "response",
      created_at: 0,
      model: "gpt-test",
      output: [],
      output_text: "",
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    }),
    headers: opts.headers,
  }
})

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

function getLastHeaders(): Record<string, string> {
  const lastCall = fetchMock.mock.calls.at(-1)
  expect(lastCall).toBeTruthy()
  if (!lastCall) {
    throw new Error("Expected fetch to be called at least once")
  }

  return lastCall[1].headers
}

const basePayload = (input: ResponsesPayload["input"]): ResponsesPayload => ({
  model: "gpt-test",
  input,
})

test("keeps x-initiator as user for ordinary responses requests", async () => {
  await createResponses(basePayload([{ role: "user", content: "hello" }]), {
    vision: false,
    initiator: "user",
  })

  expect(getLastHeaders()["x-initiator"]).toBe("user")
})

test("forces agent initiator for compact responses requests", async () => {
  await createResponses(basePayload([{ role: "user", content: "hello" }]), {
    vision: false,
    initiator: "user",
    isCompact: true,
  })

  expect(getLastHeaders()["x-initiator"]).toBe("agent")
})

test("forces agent initiator for subagent responses requests", async () => {
  await createResponses(basePayload([{ role: "user", content: "hello" }]), {
    vision: false,
    initiator: "user",
    upstreamRequestId: "request-3",
    sessionId: "session-3",
    subagentMarker: {
      agent_id: "agent-3",
      agent_type: "opencode-subagent",
      session_id: "session-3",
    },
  })

  const headers = getLastHeaders()
  expect(headers["x-request-id"]).toBe("request-3")
  expect(headers["x-agent-task-id"]).toBe("request-3")
  expect(headers["x-interaction-id"]).toBe("session-3")
  expect(headers["x-interaction-type"]).toBe("conversation-subagent")
  expect(headers["x-initiator"]).toBe("agent")
})
