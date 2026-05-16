import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"

import "./shared-admin-db-test-home"

import type { RequestLogRow } from "../src/lib/request-history"
import type { AccountRuntime } from "../src/lib/types/account"
import type { Model } from "../src/services/copilot/get-models"

import { accountsManager } from "../src/lib/accounts-manager"
import { getAdminDb } from "../src/lib/admin-db"
import {
  mergeConfigWithDefaults,
  type ResolvedProviderConfig,
} from "../src/lib/config"
import { PATHS } from "../src/lib/paths"
import { state } from "../src/lib/state"

let providerConfigCalls: Array<string> = []

const getTestProviderConfig = (
  provider: string,
): ResolvedProviderConfig | null => {
  providerConfigCalls.push(provider)

  if (provider !== "dash") {
    return null
  }

  return {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://dashscope.example/compatible-mode",
    models: {
      "qwen-plus": {
        temperature: 0.2,
        toolContentSupportType: [],
      },
    },
    name: "dash",
    type: "openai-compatible",
  }
}

const { messageRoutes } = await import("../src/routes/messages/route")
const { resolveCountTokensModel } =
  await import("../src/routes/messages/count-tokens-handler")

const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
const originalFetch = fetchHolder.fetch

const originalSelectAccountForRequest =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalizeQuota =
  accountsManager.finalizeQuota.bind(accountsManager)

const originalState = {
  lastRequestTimestamp: state.lastRequestTimestamp,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
}

type SseEvent = {
  event?: string
  data: string
}

type AccountSelection = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type AccountSelectionOk = Extract<AccountSelection, { ok: true }>

const buildAccount = (): AccountRuntime => ({
  accountType: "individual",
  addedAt: Date.now(),
  copilotToken: "copilot-token",
  githubToken: "github-token",
  id: "octocat",
  premiumRemaining: 10,
  unlimited: false,
  vsCodeVersion: "1.0.0",
})

const buildModel = (id: string): Model => ({
  capabilities: {
    family: "test",
    limits: {},
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id,
  model_picker_enabled: true,
  name: id,
  object: "model",
  preview: false,
  vendor: "upstream",
  version: "test",
})

const buildSelection = (
  endpoint: string,
  modelId: string,
): AccountSelectionOk => ({
  account: buildAccount(),
  affinityHit: false,
  confirmAffinity: mock(() => {}),
  confirmOwnership: mock(() => {}),
  costUnits: 0,
  endpoint,
  ok: true,
  selectedModel: buildModel(modelId),
  selectionReason: "affinity_miss",
})

const createChatCompletionResponse = (): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          logprobs: null,
          message: {
            content: "answer text",
            role: "assistant",
          },
        },
      ],
      created: 0,
      id: "chatcmpl-test",
      model: "qwen-plus",
      object: "chat.completion",
      usage: {
        completion_tokens: 2,
        prompt_tokens: 8,
        total_tokens: 10,
      },
    }),
    {
      headers: {
        "content-type": "application/json",
      },
    },
  )

let createUpstreamResponse = createChatCompletionResponse

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(createUpstreamResponse()),
)

const parseSse = (body: string): Array<SseEvent> => {
  const blocks = body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  return blocks.map((block) => {
    const lines = block.split("\n")
    let event: string | undefined
    const dataLines: Array<string> = []

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim() || undefined
        continue
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim())
      }
    }

    return {
      event,
      data: dataLines.join("\n"),
    }
  })
}

const createApp = () => {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("providerConfigResolver" as never, getTestProviderConfig as never)
    c.set("providerFetch" as never, fetchMock as never)
    await next()
  })
  app.route("/v1/messages", messageRoutes)
  return app
}

const writeTestConfig = (config: Record<string, unknown>): void => {
  fs.writeFileSync(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()
}

beforeEach(() => {
  createUpstreamResponse = createChatCompletionResponse
  providerConfigCalls = []
  state.rateLimitSeconds = 60
  state.rateLimitWait = false
  state.lastRequestTimestamp = Date.now()
  writeTestConfig({ auth: { apiKeys: [] }, providers: {} })

  getAdminDb().run("DELETE FROM request_log;")
  fetchMock.mockClear()
})

afterEach(() => {
  fetchHolder.fetch = originalFetch
  accountsManager.selectAccountForRequest = originalSelectAccountForRequest
  accountsManager.finalizeQuota = originalFinalizeQuota
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.rateLimitWait = originalState.rateLimitWait
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
})

describe("provider/model aliases on top-level messages routes", () => {
  test("routes /v1/messages to the provider and strips the provider prefix", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(state.lastRequestTimestamp).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    )

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")

    const json = (await response.json()) as { model: string }
    expect(json.model).toBe("qwen-plus")

    const row = getAdminDb()
      .query("SELECT * FROM request_log WHERE client_model = ? LIMIT 1;")
      .get("dash/qwen-plus") as RequestLogRow | null
    expect(row?.path).toBe("/v1/messages")
    expect(row?.upstream_endpoint).toBe("/providers/dash/messages")
    expect(row?.upstream_model).toBe("qwen-plus")
    expect(row?.account_id).toBeNull()
    expect(row?.cost_units).toBeNull()
    expect(row?.http_status).toBe(200)
  })

  test("routes modelAliases provider targets on /v1/messages", async () => {
    writeTestConfig({
      auth: { apiKeys: [] },
      modelAliases: {
        "claude-opus-4-7": {
          allowOriginal: true,
          target: "dash/qwen-plus",
        },
      },
      providers: {},
    })

    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "claude-opus-4-7",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(providerConfigCalls).toContain("dash")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")

    const row = getAdminDb()
      .query("SELECT * FROM request_log WHERE client_model = ? LIMIT 1;")
      .get("claude-opus-4-7") as RequestLogRow | null
    expect(row?.upstream_endpoint).toBe("/providers/dash/messages")
    expect(row?.upstream_model).toBe("qwen-plus")
    expect(row?.account_id).toBeNull()
  })

  test("falls back to Copilot model aliases when slash prefix is not a provider", async () => {
    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/chat/completions", "gpt-5.4"))
    accountsManager.finalizeQuota = () => Promise.resolve()
    createUpstreamResponse = () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              logprobs: null,
              message: {
                content: "copilot answer",
                role: "assistant",
              },
            },
          ],
          created: 0,
          id: "chatcmpl-copilot",
          model: "gpt-5.4",
          object: "chat.completion",
          usage: {
            completion_tokens: 2,
            prompt_tokens: 8,
            total_tokens: 10,
          },
        }),
        {
          headers: {
            "content-type": "application/json",
          },
        },
      )

    state.rateLimitSeconds = undefined
    fetchHolder.fetch = fetchMock as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "copilot/gpt-5.4",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const upstreamBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>
    expect(upstreamBody.model).toBe("gpt-5.4")
    expect(await response.json()).toMatchObject({
      model: "gpt-5.4",
    })

    const row = getAdminDb()
      .query("SELECT * FROM request_log WHERE client_model = ? LIMIT 1;")
      .get("copilot/gpt-5.4") as RequestLogRow | null
    expect(row?.upstream_endpoint).toBe("/chat/completions")
    expect(row?.upstream_model).toBe("gpt-5.4")
    expect(row?.http_status).toBe(200)
  })

  test("records streaming provider aliases after the stream completes", async () => {
    createUpstreamResponse = () =>
      new Response(
        [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { role: "assistant" },
                finish_reason: null,
                index: 0,
              },
            ],
            created: 0,
            id: "chatcmpl-stream",
            model: "qwen-plus",
            object: "chat.completion.chunk",
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { content: "answer text" },
                finish_reason: null,
                index: 0,
              },
            ],
            created: 0,
            id: "chatcmpl-stream",
            model: "qwen-plus",
            object: "chat.completion.chunk",
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {},
                finish_reason: "stop",
                index: 0,
              },
            ],
            created: 0,
            id: "chatcmpl-stream",
            model: "qwen-plus",
            object: "chat.completion.chunk",
            usage: {
              completion_tokens: 2,
              prompt_tokens: 8,
              total_tokens: 10,
            },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        {
          headers: {
            "content-type": "text/event-stream",
          },
        },
      )

    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const rowBeforeConsumption = getAdminDb()
      .query("SELECT * FROM request_log WHERE client_model = ? LIMIT 1;")
      .get("dash/qwen-plus") as RequestLogRow | null
    expect(rowBeforeConsumption).toBeNull()

    const events = parseSse(await response.text())
    expect(events.some((event) => event.event === "message_stop")).toBe(true)

    const row = getAdminDb()
      .query("SELECT * FROM request_log WHERE client_model = ? LIMIT 1;")
      .get("dash/qwen-plus") as RequestLogRow | null
    expect(row?.http_status).toBe(200)
    expect(row?.stream).toBe(1)
    expect(row?.tokens_input).toBe(8)
    expect(row?.tokens_output).toBe(2)
  })

  test("records streaming provider alias parse failures as errors", async () => {
    createUpstreamResponse = () =>
      new Response("data: {not-json}\n\n", {
        headers: {
          "content-type": "text/event-stream",
        },
      })

    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const events = parseSse(await response.text())
    expect(events.some((event) => event.event === "error")).toBe(true)

    const row = getAdminDb()
      .query("SELECT * FROM request_log WHERE client_model = ? LIMIT 1;")
      .get("dash/qwen-plus") as RequestLogRow | null
    expect(row?.http_status).toBe(500)
    expect(row?.error_name).toBe("Error")
    expect(row?.error_message).toBe(
      "Failed to parse OpenAI-compatible stream chunk",
    )
  })

  test("routes /v1/messages/count_tokens to provider token counting with the stripped model", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test("routes modelAliases provider targets to count_tokens provider token counting", async () => {
    writeTestConfig({
      auth: { apiKeys: [] },
      modelAliases: {
        "claude-opus-4-7": {
          allowOriginal: true,
          target: "dash/qwen-plus",
        },
      },
      providers: {},
    })

    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "claude-opus-4-7",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(0)
    expect(providerConfigCalls).toContain("dash")
  })

  test("estimates count_tokens locally when slash prefix is not a provider", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "copilot/gpt-5.4",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    const json = (await response.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test("resolves missing top-level count_tokens models to the o200k_base fallback model", () => {
    const resolved = resolveCountTokensModel("missing-model", () => undefined)

    expect(resolved.fallback).toBe(true)
    expect(resolved.model.id).toBe("missing-model")
    expect(resolved.model.capabilities.tokenizer).toBe("o200k_base")
  })

  test("returns a validation error when provider token counting receives an invalid payload", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Invalid Anthropic messages count_tokens payload",
        type: "invalid_request_error",
      },
    })
  })
})
