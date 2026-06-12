import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AccountRuntime } from "~/lib/types/account"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { getAdminDb } from "~/lib/admin-db"
import {
  compactMessageSections,
  compactSummaryPromptStart,
  compactTextOnlyGuard,
} from "~/lib/compact"
import { getSmallModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getUUID } from "~/lib/utils"
import { messageRoutes } from "~/routes/messages/route"

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

type FetchOptions = {
  body?: unknown
}

const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
const originalFetch = fetchHolder.fetch
const originalSelect =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)
const originalMarkFailed =
  accountsManager.markAccountFailed.bind(accountsManager)

function parseFetchBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new TypeError("Expected fetch body to be a JSON string")
  }

  return JSON.parse(body) as Record<string, unknown>
}

function buildAccount(): AccountRuntime {
  return {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghu_test",
    copilotToken: "copilot_test",
    vsCodeVersion: "1.0.0",
    premiumRemaining: 10,
    unlimited: false,
  }
}

function buildModel(id: string): Model {
  return {
    id,
    name: id,
    vendor: "upstream",
    object: "model",
    preview: false,
    version: "test",
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      limits: {
        max_output_tokens: 8192,
        max_prompt_tokens: 200_000,
      },
      object: "capabilities",
      supports: {
        adaptive_thinking: true,
        streaming: true,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function buildSelection(endpoint: string, modelId: string): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel(modelId),
    endpoint,
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    confirmOwnership: mock(() => {}),
    affinityHit: false,
    selectionReason: "affinity_miss",
  }
}

function buildAnthropicResponse(model: string, text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
  }
}

function buildResponsesResult(model: string, text: string) {
  return {
    id: "resp_1",
    object: "response",
    created_at: Date.now(),
    model,
    output: [
      {
        id: "out_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    output_text: text,
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
  }
}

function buildChatCompletionResponse(model: string, text: string) {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }
}

function createPayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "original-model",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
}

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false

  getAdminDb().run("DELETE FROM session_affinity;")

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/v1/messages", "messages-model"))
  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}
})

afterEach(() => {
  fetchHolder.fetch = originalFetch
  accountsManager.selectAccountForRequest = originalSelect
  accountsManager.finalizeQuota = originalFinalize
  accountsManager.markAccountFailed = originalMarkFailed
})

describe("messages handler sanitization", () => {
  test("removes executeCode and rewrites getDiagnostics before forwarding tools", async () => {
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/v1/messages", "messages-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "messages")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            tools: [
              {
                name: "mcp__ide__executeCode",
                description: "Execute code in VS Code",
                input_schema: { type: "object" },
              },
              {
                name: "mcp__ide__getDiagnostics",
                description: "Old description",
                input_schema: { type: "object" },
              },
              {
                name: "keep_me",
                description: "Keep me",
                input_schema: { type: "object" },
              },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.tools).toEqual([
      {
        name: "mcp__ide__getDiagnostics",
        description:
          "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace.",
        input_schema: { type: "object" },
      },
      {
        name: "keep_me",
        description: "Keep me",
        input_schema: { type: "object" },
      },
    ])
    expect(selection.confirmAffinity).toHaveBeenCalledTimes(1)
    expect(selection.confirmOwnership).toHaveBeenCalledTimes(1)
  })
})

describe("messages handler cache_control merge", () => {
  test("adds cache_control to the last content block after merging tool_result content", async () => {
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/v1/messages", "messages-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "messages")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-1",
                    content: "Launching skill: foo",
                  },
                  {
                    type: "text",
                    text: "[Pasted ~4 lines]",
                  },
                ],
              },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Launching skill: foo\n\n[Pasted ~4 lines]",
            cache_control: {
              type: "ephemeral",
            },
          },
        ],
      },
    ])
  })

  test("preserves cache_control captured before Tool loaded is stripped", async () => {
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/v1/messages", "messages-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "messages")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-1",
                    content: [
                      {
                        type: "tool_reference",
                        tool_name: "AskUserQuestion",
                      },
                    ],
                  },
                  {
                    type: "text",
                    text: "Tool loaded.",
                    cache_control: {
                      type: "ephemeral",
                      scope: "user",
                    },
                  },
                ],
              },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "tool_reference",
                tool_name: "AskUserQuestion",
              },
            ],
            cache_control: {
              type: "ephemeral",
              scope: "user",
            },
          },
        ],
      },
    ])
  })

  test("merges earlier tool_result content but skips the final compact message", async () => {
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/v1/messages", "messages-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "messages")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const compactText = `${compactTextOnlyGuard}\n\n${compactSummaryPromptStart}\n\n${compactMessageSections[0]}\n- summarize`
    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-1",
                    content: "Launching skill: foo",
                  },
                  {
                    type: "text",
                    text: "Follow-up details",
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-compact",
                    content: "Compact setup",
                  },
                  {
                    type: "text",
                    text: compactText,
                  },
                ],
              },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Launching skill: foo\n\nFollow-up details",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-compact",
            content: "Compact setup",
          },
          {
            type: "text",
            text: compactText,
            cache_control: {
              type: "ephemeral",
            },
          },
        ],
      },
    ])
  })
})

describe("messages handler routing", () => {
  test("routes to the Messages API when selection chooses /v1/messages", async () => {
    let requestedUrl = ""
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/v1/messages", "messages-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((url: string, opts?: FetchOptions) => {
      requestedUrl = url
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "messages")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    const body = (await response.json()) as {
      content: Array<{ text: string }>
    }

    expect(response.status).toBe(200)
    expect(requestedUrl).toContain("/v1/messages")
    expect(upstreamBody?.model).toBe("messages-model")
    expect(body.content[0].text).toBe("messages")
    expect(selection.confirmAffinity).toHaveBeenCalledTimes(1)
    expect(selection.confirmOwnership).toHaveBeenCalledTimes(1)
  })

  test("routes to the Responses API when selection chooses /responses", async () => {
    let requestedUrl = ""
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/responses", "responses-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((url: string, opts?: FetchOptions) => {
      requestedUrl = url
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-model", "responses")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    const body = (await response.json()) as {
      content: Array<{ text: string }>
    }

    expect(response.status).toBe(200)
    expect(requestedUrl).toContain("/responses")
    expect(upstreamBody?.model).toBe("responses-model")
    expect(body.content[0].text).toBe("responses")
    expect(selection.confirmAffinity).toHaveBeenCalledTimes(1)
    expect(selection.confirmOwnership).toHaveBeenCalledTimes(1)
  })

  test("falls back to Chat Completions when selection chooses /chat/completions", async () => {
    let requestedUrl = ""
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/chat/completions", "chat-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((url: string, opts?: FetchOptions) => {
      requestedUrl = url
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildChatCompletionResponse("chat-model", "chat")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    const body = (await response.json()) as {
      content: Array<{ text: string }>
    }

    expect(response.status).toBe(200)
    expect(requestedUrl).toContain("/chat/completions")
    expect(upstreamBody?.model).toBe("chat-model")
    expect(body.content[0].text).toBe("chat")
    expect(selection.confirmAffinity).toHaveBeenCalledTimes(1)
    expect(selection.confirmOwnership).toHaveBeenCalledTimes(1)
  })
})

describe("messages handler affinity context", () => {
  test("warmup requests switch candidate model before account selection", async () => {
    let selectionCandidates: Array<{ modelId: string; endpoint: string }> = []
    let selectionRequestId: string | undefined
    let selectionAffinityModelId: string | undefined

    accountsManager.selectAccountForRequest = (candidates, options) => {
      selectionCandidates = candidates
      selectionRequestId = options?.requestId
      selectionAffinityModelId = options?.affinityModelId

      return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "warmup")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const payload = createPayload({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"sub-session","agent_id":"agent-1","agent_type":"Explore"}</system-reminder>',
            },
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    })

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "warmup-beta",
          "x-session-id": "session-123",
        },
        body: JSON.stringify(payload),
      }),
    )

    const expectedSessionId = getUUID("session-123")

    expect(response.status).toBe(200)
    expect(selectionCandidates[0]?.modelId).toBe(getSmallModel())
    expect(selectionCandidates[0]?.endpoint).toBe("/v1/messages")
    expect(selectionRequestId).toBe(expectedSessionId)
    expect(selectionAffinityModelId).toBe("original-model")
  })

  test("compact requests keep original model for affinity while routing small model", async () => {
    let selectionCandidates: Array<{ modelId: string; endpoint: string }> = []
    let selectionAffinityModelId: string | undefined

    accountsManager.selectAccountForRequest = (candidates, options) => {
      selectionCandidates = candidates
      selectionAffinityModelId = options?.affinityModelId

      return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "compact")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            system:
              "You are a helpful AI assistant tasked with summarizing conversations",
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionCandidates[0]?.modelId).toBe(getSmallModel())
    expect(selectionCandidates[0]?.endpoint).toBe("/v1/messages")
    expect(selectionAffinityModelId).toBe("original-model")
  })

  test("metadata session_id takes priority over x-session-id header for affinity key", async () => {
    let selectionRequestId: string | undefined

    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionRequestId = options?.requestId
      return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const metadataSessionId = "metadata-session-id-123"
    const payload = createPayload({
      metadata: {
        user_id: JSON.stringify({
          device_id: "device-1",
          session_id: metadataSessionId,
        }),
      },
    })

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "header-session-should-be-ignored",
        },
        body: JSON.stringify(payload),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionRequestId).toBe(getUUID(metadataSessionId))
  })
})

describe("messages handler ownership context", () => {
  test("main-agent requests write ownership session id during selection", async () => {
    let selectionOwnershipLookupSessionId: string | undefined
    let selectionOwnershipWriteSessionId: string | undefined

    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionOwnershipLookupSessionId = options?.ownershipLookupSessionId
      selectionOwnershipWriteSessionId = options?.ownershipWriteSessionId
      return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "root-session-123",
        },
        body: JSON.stringify(createPayload()),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionOwnershipLookupSessionId).toBeUndefined()
    expect(selectionOwnershipWriteSessionId).toBe(getUUID("root-session-123"))
  })

  test("documentation mentions of the marker literal do not suppress ownership writes", async () => {
    let selectionOwnershipLookupSessionId: string | undefined
    let selectionOwnershipWriteSessionId: string | undefined

    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionOwnershipLookupSessionId = options?.ownershipLookupSessionId
      selectionOwnershipWriteSessionId = options?.ownershipWriteSessionId
      return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "root-session-123",
        },
        body: JSON.stringify(
          createPayload({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "<system-reminder>Subagent semantics depend on `__SUBAGENT_MARKER__` propagation from Claude Code or opencode plugins.</system-reminder>",
                  },
                  {
                    type: "text",
                    text: "hello",
                  },
                ],
              },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionOwnershipLookupSessionId).toBeUndefined()
    expect(selectionOwnershipWriteSessionId).toBe(getUUID("root-session-123"))
  })

  test("valid subagent requests look up normalized ownership session id during selection", async () => {
    let selectionOwnershipLookupSessionId: string | undefined
    let selectionOwnershipWriteSessionId: string | undefined

    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionOwnershipLookupSessionId = options?.ownershipLookupSessionId
      selectionOwnershipWriteSessionId = options?.ownershipWriteSessionId
      return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "root-session-123",
        },
        body: JSON.stringify(
          createPayload({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"  sub-session  ","agent_id":"agent-1","agent_type":"Explore"}</system-reminder>',
                  },
                  {
                    type: "text",
                    text: "hello",
                  },
                ],
              },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionOwnershipLookupSessionId).toBe(getUUID("sub-session"))
    expect(selectionOwnershipWriteSessionId).toBeUndefined()
  })
})

describe("messages handler unauthorized classification", () => {
  test("ownership mismatch 401 invalidates stale affinity mapping and does not trigger markAccountFailed", async () => {
    const markFailedSpy = mock(() => {})
    const cacheKey = "test-cache-key"

    getAdminDb()
      .query(
        `INSERT INTO session_affinity (
          cache_key,
          account_id,
          created_at_ms,
          last_confirmed_at_ms,
          last_used_at_ms
        ) VALUES (?, ?, ?, ?, ?);`,
      )
      .run(cacheKey, "octocat", 1, 1, 1)

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve({
        ...buildSelection("/responses", "responses-model"),
        affinityHit: true,
        affinityCacheKey: cacheKey,
        selectionReason: "affinity_hit",
      })
    accountsManager.markAccountFailed = markFailedSpy

    const fetchMock = mock(() =>
      Promise.reject(
        new HTTPError(
          'input item ID "msg_abc" does not belong to this connection',
          new Response("ownership mismatch", { status: 401 }),
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    const affinityRow = getAdminDb()
      .query(
        "SELECT account_id FROM session_affinity WHERE cache_key = ? LIMIT 1;",
      )
      .get(cacheKey) as { account_id?: string } | null

    expect(response.status).toBe(401)
    expect(markFailedSpy).not.toHaveBeenCalled()
    expect(affinityRow).toBeNull()
  })

  test("ownership mismatch during responses stream invalidates stale affinity mapping and does not trigger markAccountFailed", async () => {
    const markFailedSpy = mock(() => {})
    const cacheKey = "test-stream-cache-key"
    const encoder = new TextEncoder()

    getAdminDb()
      .query(
        `INSERT INTO session_affinity (
          cache_key,
          account_id,
          created_at_ms,
          last_confirmed_at_ms,
          last_used_at_ms
        ) VALUES (?, ?, ?, ?, ?);`,
      )
      .run(cacheKey, "octocat", 1, 1, 1)

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve({
        ...buildSelection("/responses", "responses-model"),
        affinityHit: true,
        affinityCacheKey: cacheKey,
        selectionReason: "affinity_hit",
      })
    accountsManager.markAccountFailed = markFailedSpy

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'),
              )
              queueMicrotask(() => {
                controller.error(
                  new HTTPError(
                    'input item ID "msg_abc" does not belong to this connection',
                    new Response("ownership mismatch", { status: 401 }),
                  ),
                )
              })
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload({ stream: true })),
      }),
    )

    await response.text()

    const affinityRow = getAdminDb()
      .query(
        "SELECT account_id FROM session_affinity WHERE cache_key = ? LIMIT 1;",
      )
      .get(cacheKey) as { account_id?: string } | null

    expect(response.status).toBe(200)
    expect(markFailedSpy).not.toHaveBeenCalled()
    expect(affinityRow).toBeNull()
  })

  test("genuine unauthorized 401 does trigger markAccountFailed", async () => {
    const markFailedSpy = mock(() => {})

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    accountsManager.markAccountFailed = markFailedSpy

    const fetchMock = mock(() =>
      Promise.reject(
        new HTTPError(
          "Unauthorized",
          new Response("unauthorized", { status: 401 }),
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    expect(response.status).toBe(401)
    expect(markFailedSpy).toHaveBeenCalledTimes(1)
    expect(markFailedSpy).toHaveBeenCalledWith("octocat", "Unauthorized (401)")
  })
})
