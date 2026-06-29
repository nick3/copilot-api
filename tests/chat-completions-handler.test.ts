import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

const actualRateLimitModule = await import("../src/lib/rate-limit")

await mock.module("~/lib/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit: () => {},
}))

import { state } from "../src/lib/state"
import { accountsManager } from "../src/lib/accounts-manager"
import {
  closeUsageStore,
  getTokenUsageEventsPage,
} from "../src/lib/token-usage"
import { completionRoutes } from "../src/routes/chat-completions/route"

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

const originalFetch = globalThis.fetch
const originalSelect =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)
const originalMarkFailed =
  accountsManager.markAccountFailed.bind(accountsManager)
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
  vsCodeVersion: state.vsCodeVersion,
}
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
let dbPathBeforeTest: string | undefined

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

function buildSelection(modelId: string): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel(modelId),
    endpoint: "/chat/completions",
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    affinityHit: false,
    selectionReason: "affinity_miss",
  }
}

const fetchMock = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "gpt-test",
        choices: [],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createApp = () => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app
}

beforeEach(async () => {
  dbPathBeforeTest = process.env[DB_PATH_ENV]
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()

  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.rateLimitWait = false
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("gpt-test"))
  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}

  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(async () => {
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.manualApprove = originalState.manualApprove
  state.verbose = originalState.verbose
  state.vsCodeVersion = originalState.vsCodeVersion
  state.rateLimitWait = originalState.rateLimitWait
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
  accountsManager.selectAccountForRequest = originalSelect
  accountsManager.finalizeQuota = originalFinalize
  accountsManager.markAccountFailed = originalMarkFailed
  await closeUsageStore()
  if (dbPathBeforeTest === undefined) {
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  } else {
    process.env[DB_PATH_ENV] = dbPathBeforeTest
  }
  dbPathBeforeTest = undefined
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("chat completions handler", () => {
  test("rejects gpt-5.4 requests with invalid request error", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Please use `/v1/responses` or `/v1/messages` API",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("records Copilot AIU from non-streaming Chat Completions responses", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "gpt-test",
            choices: [],
            copilot_usage: {
              total_nano_aiu: 1_000_000_000,
            },
            usage: {
              prompt_tokens: 5,
              completion_tokens: 2,
              total_tokens: 7,
              prompt_tokens_details: {
                cached_tokens: 1,
              },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      ),
    )

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    await response.text()

    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "day",
    })

    expect(response.status).toBe(200)
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      cache_read_input_tokens: 1,
      cost: {
        amount: 0.01,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 10_000_000,
      },
      endpoint: "chat_completions",
      input_tokens: 4,
      model: "gpt-test",
      output_tokens: 2,
      source: "copilot",
      total_nano_aiu: 1_000_000_000,
      total_tokens: 7,
    })
  })

  test("records Copilot AIU from streaming Chat Completions chunks", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            "data: "
              + JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 0,
                model: "gpt-test",
                choices: [],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 4,
                  total_tokens: 14,
                  prompt_tokens_details: {
                    cached_tokens: 3,
                  },
                },
              }),
            "",
            "data: "
              + JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 0,
                model: "gpt-test",
                choices: [],
                copilot_usage: {
                  total_nano_aiu: 3_000_000_000,
                },
              }),
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    await response.text()

    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "day",
    })

    expect(response.status).toBe(200)
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      cache_read_input_tokens: 3,
      cost: {
        amount: 0.03,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 30_000_000,
      },
      endpoint: "chat_completions",
      input_tokens: 7,
      model: "gpt-test",
      output_tokens: 4,
      source: "copilot",
      total_nano_aiu: 3_000_000_000,
      total_tokens: 14,
    })
  })
})
