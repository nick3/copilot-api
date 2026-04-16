import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AccountRuntime } from "~/lib/types/account"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import {
  compactAutoContinueClaudeCodePromptStart,
  compactSummaryPromptStart,
  compactTextOnlyGuard,
} from "~/lib/compact"
import { state } from "~/lib/state"
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

const compactSummaryPrompt = `${compactTextOnlyGuard}\n\n${compactSummaryPromptStart}, paying close attention to the user's explicit requests and your previous actions.\n\n7. Pending Tasks:\n   - [Task 1]\n\n8. Current Work:\n   [Current work]`

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

function buildToolContinuationMessages(
  lastUserContent: string,
): AnthropicMessagesPayload["messages"] {
  return [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "ok",
        },
        {
          type: "text",
          text: "continue from tool",
        },
      ],
    },
    {
      role: "user",
      content: lastUserContent,
    },
  ]
}

function createPayload(
  messages: AnthropicMessagesPayload["messages"],
): AnthropicMessagesPayload {
  return {
    model: "original-model",
    max_tokens: 128,
    messages,
  }
}

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false

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

describe("messages handler compact preprocessing", () => {
  test("compact summary requests preserve prior tool_result continuations", async () => {
    let upstreamBody: Record<string, unknown> | undefined

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const messages = buildToolContinuationMessages(compactSummaryPrompt)
    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload(messages)),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.messages).toEqual(messages)
  })

  test("compact auto-continue requests preserve prior tool_result continuations", async () => {
    let upstreamBody: Record<string, unknown> | undefined

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const messages = buildToolContinuationMessages(
      compactAutoContinueClaudeCodePromptStart,
    )
    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload(messages)),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.messages).toEqual(messages)
  })
})
