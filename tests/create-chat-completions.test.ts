import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { COMPACT_REQUEST } from "../src/lib/compact"
import { state } from "../src/lib/state"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"

type FetchOpts = {
  headers: Record<string, string>
  body?: string
}

const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  vsCodeVersion: state.vsCodeVersion,
}

// Helper to mock fetch
const fetchMock = mock((_url: string, opts: FetchOpts) => {
  return {
    ok: true,
    json: () => ({ id: "123", object: "chat.completion", choices: [] }),
    headers: opts.headers,
  }
})

beforeEach(() => {
  state.githubToken = "test-github-token"
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  fetchMock.mockClear()
})

afterEach(() => {
  state.githubToken = originalState.githubToken
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
})

function getLastFetchCall(): FetchOpts {
  const last = fetchMock.mock.calls.at(-1)?.[1]

  expect(last).toBeTruthy()
  return last as FetchOpts
}

function getLastUpstreamPayload(): Record<string, unknown> {
  const { body } = getLastFetchCall()
  expect(body).toBeTruthy()
  return JSON.parse(body as string) as Record<string, unknown>
}

const callCreateChatCompletions = (
  payload: ChatCompletionsPayload,
  options: Parameters<typeof createChatCompletions>[2] = {},
) =>
  createChatCompletions(payload, undefined, {
    ...options,
    fetchImpl: fetchMock as unknown as typeof fetch,
  })

test("sets x-initiator to agent if tool/assistant present", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }

  await callCreateChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const { headers } = getLastFetchCall()
  expect(headers["x-initiator"]).toBe("agent")
  expect(headers["x-request-id"]).toBeTruthy()
  expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
})

test("sets x-initiator to user if only user present", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }

  await callCreateChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const { headers } = getLastFetchCall()
  expect(headers["x-initiator"]).toBe("user")
})

test("respects explicit initiator override", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }

  await callCreateChatCompletions(payload, { initiator: "agent" })

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const { headers } = getLastFetchCall()
  expect(headers["x-initiator"]).toBe("agent")
})

test("sets interaction headers for explicit session and subagent", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }

  await callCreateChatCompletions(payload, {
    upstreamRequestId: "request-1",
    sessionId: "session-1",
    subagentMarker: {
      agent_id: "agent-1",
      agent_type: "opencode-subagent",
      session_id: "session-1",
    },
  })

  const { headers } = getLastFetchCall()
  expect(headers["x-request-id"]).toBe("request-1")
  expect(headers["x-agent-task-id"]).toBe("request-1")
  expect(headers["x-interaction-id"]).toBe("session-1")
  expect(headers["x-interaction-type"]).toBe("conversation-subagent")
  expect(headers["x-initiator"]).toBe("agent")
})

test("forces agent initiator for compact chat requests", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }

  await callCreateChatCompletions(payload, {
    compactType: COMPACT_REQUEST,
  })

  const { headers } = getLastFetchCall()
  expect(headers["x-initiator"]).toBe("agent")
})

test("keeps subagent interaction type for compact chat requests", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }

  await callCreateChatCompletions(payload, {
    upstreamRequestId: "request-compact-chat",
    sessionId: "session-compact-chat",
    subagentMarker: {
      agent_id: "agent-compact-chat",
      agent_type: "opencode-subagent",
      session_id: "session-compact-chat",
    },
    compactType: COMPACT_REQUEST,
  })

  const { headers } = getLastFetchCall()
  expect(headers["x-request-id"]).toBe("request-compact-chat")
  expect(headers["x-agent-task-id"]).toBe("request-compact-chat")
  expect(headers["x-interaction-id"]).toBe("session-compact-chat")
  expect(headers["x-interaction-type"]).toBe("conversation-compaction")
  expect(headers["openai-intent"]).toBe("conversation-agent")
  expect(headers["x-initiator"]).toBe("agent")
})

test("passes through explicit reasoning_effort unchanged", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5-mini",
    reasoning_effort: "high",
  }

  await callCreateChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(upstreamPayload["reasoning_effort"]).toBe("high")
})

test("passes through reasoning_effort for non-gpt-5-mini models", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
    reasoning_effort: "low",
  }

  await callCreateChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(upstreamPayload["reasoning_effort"]).toBe("low")
})

test("does not inject reasoning_effort for non-gpt-5-mini models when omitted", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }

  await callCreateChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(Object.hasOwn(upstreamPayload, "reasoning_effort")).toBe(false)
})
