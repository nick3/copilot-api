import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"

const actualConfigModule = await import("../src/lib/config")
const actualRateLimitModule = await import("../src/lib/rate-limit")
const actualTokenUsageModule = await import("../src/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null
let modelMappings: Record<string, string> = {}

const checkRateLimit = mock(() => {
  throw new Error("Copilot rate limit should not run for provider aliases")
})
const noopTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: () => providerConfig,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))

await mock.module("~/lib/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit,
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { completionRoutes } =
  await import("../src/routes/chat-completions/route")

const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
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
    ),
  ),
)

const createApp = () => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app
}

beforeEach(() => {
  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://dashscope.example/compatible-mode",
    models: {
      "qwen-plus": {
        extraBody: {
          enable_thinking: true,
          preserve_thinking: true,
        },
        temperature: 0.2,
        topK: 50,
        topP: 0.8,
      },
    },
    name: "dash",
    type: "openai-compatible",
  }

  modelMappings = {}
  checkRateLimit.mockClear()
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("provider/model aliases on top-level chat completions route", () => {
  test("routes mapped models to provider chat completions before rate limiting", async () => {
    modelMappings = {
      "gpt-provider": "dash/qwen-plus",
    }

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "gpt-provider",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    )
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")
  })

  test("strips provider prefix and applies provider model defaults", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const upstreamBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >
    expect(upstreamBody).toMatchObject({
      enable_thinking: true,
      model: "qwen-plus",
      preserve_thinking: true,
      temperature: 0.2,
      top_k: 50,
      top_p: 0.8,
    })
  })

  test("keeps request fields over provider defaults and adds stream usage option", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        enable_thinking: false,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
        stream_options: {
          include_usage: false,
        },
        temperature: 0.4,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const upstreamBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >
    expect(upstreamBody.temperature).toBe(0.4)
    expect(upstreamBody.enable_thinking).toBe(false)
    expect(upstreamBody.stream_options).toEqual({
      include_usage: true,
    })
  })

  test("rejects providers without chat completions support", async () => {
    providerConfig = {
      ...(providerConfig as ResolvedProviderConfig),
      type: "openai-responses",
    }

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
      error: {
        message:
          "Provider 'dash' does not support the /v1/chat/completions endpoint",
        type: "invalid_request_error",
      },
    })
  })
})
