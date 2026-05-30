import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AccountContext } from "~/lib/types/account"
import type {
  ResponsesPayload,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { COMPACT_REQUEST } from "~/lib/compact"
import { state } from "~/lib/state"
import {
  buildResponsesWebSocketPoolKey,
  buildResponsesWebSocketPayload,
  buildResponsesWebSocketUrl,
  createResponses,
  prepareResponsesWebSocketRequest,
} from "~/services/copilot/create-responses"

const originalOauthApp = process.env.COPILOT_API_OAUTH_APP
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

const account: AccountContext = {
  accountType: "individual",
  githubToken: "test-github-token",
  copilotToken: "test-token",
  vsCodeVersion: "1.120.0",
  clientDeviceId: "device-1",
  clientMachineId: "machine-1",
  clientSessionId: "session-1",
}

const createResponsesResult = (model: string): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(JSON.stringify(createResponsesResult("gpt-test")), {
      headers: {
        "content-type": "application/json",
      },
      status: 200,
    }),
  ),
)

const fetchImpl = fetchMock as unknown as typeof fetch

const basePayload = (input: ResponsesPayload["input"]): ResponsesPayload => ({
  input,
  model: "gpt-test",
})

const getLastRequestInit = (): RequestInit & {
  headers: Record<string, string>
} => {
  const lastCall = fetchMock.mock.calls.at(-1)
  expect(lastCall).toBeTruthy()
  if (!lastCall) {
    throw new Error("Expected fetch to be called at least once")
  }

  return lastCall[1] as RequestInit & { headers: Record<string, string> }
}

beforeEach(() => {
  delete process.env.COPILOT_API_OAUTH_APP
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.macMachineId = "machine-1"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"
  fetchMock.mockClear()
})

afterEach(() => {
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = originalOauthApp
  }

  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.macMachineId = originalState.macMachineId
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
})

describe("createResponses HTTP headers", () => {
  test("keeps x-initiator as user for ordinary responses requests", async () => {
    await createResponses(
      basePayload([{ role: "user", content: "hello" }]),
      {
        fetchImpl,
        initiator: "user",
        upstreamRequestId: "request-1",
        vision: false,
      },
      account,
    )

    expect(getLastRequestInit().headers["x-initiator"]).toBe("user")
    expect(getLastRequestInit().headers["x-request-id"]).toBe("request-1")
  })

  test("forces agent initiator for compact responses requests", async () => {
    await createResponses(
      basePayload([{ role: "user", content: "hello" }]),
      {
        compactType: COMPACT_REQUEST,
        fetchImpl,
        initiator: "user",
        upstreamRequestId: "request-compact",
        vision: false,
      },
      account,
    )

    const headers = getLastRequestInit().headers
    expect(headers["x-initiator"]).toBe("agent")
    expect(headers["x-interaction-type"]).toBe("conversation-compaction")
    expect(headers["openai-intent"]).toBe("conversation-agent")
  })

  test("keeps subagent interaction type for compact responses requests", async () => {
    await createResponses(
      basePayload([{ role: "user", content: "hello" }]),
      {
        compactType: COMPACT_REQUEST,
        fetchImpl,
        initiator: "user",
        sessionId: "session-compact-responses",
        subagentMarker: {
          agent_id: "agent-compact-responses",
          agent_type: "opencode-subagent",
          session_id: "session-compact-responses",
        },
        upstreamRequestId: "request-compact-responses",
        vision: false,
      },
      account,
    )

    const headers = getLastRequestInit().headers
    expect(headers["x-request-id"]).toBe("request-compact-responses")
    expect(headers["x-agent-task-id"]).toBe("request-compact-responses")
    expect(headers["x-interaction-id"]).toBe("session-compact-responses")
    expect(headers["x-interaction-type"]).toBe("conversation-compaction")
    expect(headers["openai-intent"]).toBe("conversation-agent")
    expect(headers["x-initiator"]).toBe("agent")
  })

  test("forces agent initiator for subagent responses requests", async () => {
    await createResponses(
      basePayload([{ role: "user", content: "hello" }]),
      {
        fetchImpl,
        initiator: "user",
        sessionId: "session-3",
        subagentMarker: {
          agent_id: "agent-3",
          agent_type: "opencode-subagent",
          session_id: "session-3",
        },
        upstreamRequestId: "request-3",
        vision: false,
      },
      account,
    )

    const headers = getLastRequestInit().headers
    expect(headers["x-request-id"]).toBe("request-3")
    expect(headers["x-agent-task-id"]).toBe("request-3")
    expect(headers["x-interaction-id"]).toBe("session-3")
    expect(headers["x-interaction-type"]).toBe("conversation-subagent")
    expect(headers["x-initiator"]).toBe("agent")
  })

  test("HTTP responses requests do not move websocket-only fields into the body", async () => {
    await createResponses(
      {
        input: "hello",
        model: "gpt-test",
      },
      {
        fetchImpl,
        initiator: "user",
        upstreamRequestId: "request-1",
        vision: false,
      },
      account,
    )

    const requestInit = getLastRequestInit()
    expect(requestInit.headers["X-Request-Id"]).toBeUndefined()
    expect(typeof requestInit.body).toBe("string")

    const body = JSON.parse(requestInit.body as string) as Record<
      string,
      unknown
    >
    expect(body.initiator).toBeUndefined()
    expect(body.type).toBeUndefined()
  })
})

describe("createResponses websocket helpers", () => {
  test("builds the first websocket frame as response.create", () => {
    const payload = {
      background: true,
      input: "hello",
      model: "gpt-test",
      service_tier: "auto",
      stream: true,
    } as ResponsesPayload

    const websocketPayload = buildResponsesWebSocketPayload(payload, "agent")

    expect(websocketPayload).toEqual({
      initiator: "agent",
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    })
    expect("stream" in websocketPayload).toBe(false)
    expect("background" in websocketPayload).toBe(false)
    expect("service_tier" in websocketPayload).toBe(false)
  })

  test("builds websocket URLs from the Copilot base URL", () => {
    expect(buildResponsesWebSocketUrl("https://api.githubcopilot.com")).toBe(
      "wss://api.githubcopilot.com/responses",
    )
    expect(buildResponsesWebSocketUrl("http://localhost:3000/")).toBe(
      "ws://localhost:3000/responses",
    )
  })

  test("builds capture-style websocket headers without x-initiator", () => {
    const preparedHeaders = {
      ...copilotHeaders(account, true, "request-1"),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", false, preparedHeaders)

    const headers = copilotWebSocketHeaders(preparedHeaders)

    expect(headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Copilot-Integration-Id": "vscode-chat",
      "Copilot-Vision-Request": "true",
      "Editor-Device-Id": "device-1",
      "Editor-Plugin-Version": "copilot-chat/0.47.1",
      "Editor-Version": "vscode/1.120.0",
      "OpenAI-Intent": "conversation-agent",
      "VScode-SessionId": "session-1",
      "VScode-MachineId": "machine-1",
      "X-Agent-Task-Id": "request-1",
      "X-GitHub-Api-Version": "2026-01-09",
      "X-Interaction-Id": "interaction-1",
      "X-Interaction-Type": "conversation-agent",
      "X-Request-Id": "request-1",
      "user-agent": "node",
    })
    const headerNames = Object.keys(headers)
    const agentTaskIdIndex = headerNames.indexOf("X-Agent-Task-Id")
    expect(
      headerNames.slice(agentTaskIdIndex + 1, agentTaskIdIndex + 3),
    ).toEqual(["VScode-SessionId", "VScode-MachineId"])
    expect(headerNames[headerNames.length - 1]).toBe("user-agent")
    expect(headers.accept).toBeUndefined()
    expect(headers["accept-encoding"]).toBeUndefined()
    expect(headers["accept-language"]).toBeUndefined()
    expect(headers["cache-control"]).toBeUndefined()
    expect(headers.pragma).toBeUndefined()
    expect(headers["sec-fetch-mode"]).toBeUndefined()
    expect(headers["x-initiator"]).toBeUndefined()
    expect(headers["sec-websocket-key"]).toBeUndefined()
  })

  test("websocket request uses prepared compact and interaction headers", () => {
    const preparedHeaders = {
      ...copilotHeaders(account, false, "request-1"),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", true, preparedHeaders)
    prepareForCompact(preparedHeaders, COMPACT_REQUEST)

    const request = prepareResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-test",
        stream: true,
      },
      preparedHeaders,
      {
        requestId: "request-1",
        subagentMarker: {
          agent_id: "agent-1",
          agent_type: "Explore",
          session_id: "sub-session",
        },
      },
    )

    expect(request.payload).toMatchObject({
      initiator: "agent",
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    })
    expect(request.headers["OpenAI-Intent"]).toBe("conversation-agent")
    expect(request.headers["X-Interaction-Id"]).toBe("interaction-1")
    expect(request.headers["X-Interaction-Type"]).toBe(
      "conversation-compaction",
    )
    expect(request.headers["x-initiator"]).toBeUndefined()
  })

  test("websocket request keeps opencode headers and moves x-initiator into body", () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"

    const preparedHeaders = {
      ...copilotHeaders(account, false, "request-1"),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", true, preparedHeaders)
    prepareForCompact(preparedHeaders, COMPACT_REQUEST)

    const request = prepareResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-test",
        stream: true,
      },
      preparedHeaders,
      {
        requestId: "request-1",
      },
    )

    expect(request.payload.initiator).toBe("agent")
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Openai-Intent": "conversation-edits",
    })
    expect(request.headers["User-Agent"]).toStartWith("opencode/")
    expect(request.headers["x-initiator"]).toBeUndefined()
    expect(request.headers["X-Request-Id"]).toBeUndefined()
    expect(request.headers["x-interaction-id"]).toBeUndefined()
  })

  test("websocket pool key separates account token model request and subagent context", () => {
    const basePayload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }
    const mainKey = buildResponsesWebSocketPoolKey(basePayload, {
      copilotToken: "token-a",
      requestId: "request-1",
    })
    const otherAccountKey = buildResponsesWebSocketPoolKey(basePayload, {
      copilotToken: "token-b",
      requestId: "request-1",
    })
    const subagentKey = buildResponsesWebSocketPoolKey(basePayload, {
      copilotToken: "token-a",
      requestId: "request-1",
      subagentMarker: {
        agent_id: "agent-1",
        agent_type: "Explore",
        session_id: "sub-session",
      },
    })
    const otherModelKey = buildResponsesWebSocketPoolKey(
      {
        ...basePayload,
        model: "gpt-other",
      },
      {
        copilotToken: "token-a",
        requestId: "request-1",
      },
    )

    expect(
      new Set([mainKey, otherAccountKey, subagentKey, otherModelKey]).size,
    ).toBe(4)
    expect(mainKey).toContain("gpt-test")
    expect(mainKey).toContain("request-1")
  })

  test("websocket pool key is stable per session across turns", () => {
    const basePayload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }

    // Same session, different per-request ids (pipelined codex turns) must share
    // a pool key so the upstream connection — and its server-side
    // previous_response_id state — is reused.
    const turnOne = buildResponsesWebSocketPoolKey(basePayload, {
      copilotToken: "token-a",
      requestId: "request-1",
      sessionId: "session-abc",
    })
    const turnTwo = buildResponsesWebSocketPoolKey(basePayload, {
      copilotToken: "token-a",
      requestId: "request-2",
      sessionId: "session-abc",
    })
    const otherSession = buildResponsesWebSocketPoolKey(basePayload, {
      copilotToken: "token-a",
      requestId: "request-3",
      sessionId: "session-xyz",
    })

    expect(turnOne).toBe(turnTwo)
    expect(turnOne).not.toBe(otherSession)
  })
})
