import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { ModelsResponse } from "../src/services/copilot/get-models"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")

let enabledProviders: Array<string> = []
let providerConfigs: Record<string, ResolvedProviderConfig | null> = {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  getRawProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  listEnabledProviders: () => enabledProviders,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

const { accountsManager } = await import("../src/lib/accounts-manager")
const { resetLoggerRuntimeForTests } = await import("../src/lib/logger")
const { state } = await import("../src/lib/state")
const { adminApiRoutes } = await import("../src/routes/admin-api/route")
const { modelRoutes } = await import("../src/routes/models/route")
const { providerModelRoutes } =
  await import("../src/routes/provider/models/route")

const originalFetch = globalThis.fetch
const originalGetFirstAccountModels =
  accountsManager.getFirstAccountModels.bind(accountsManager)
const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId
let codexModelsResponseCloneCount = 0

const createProviderConfig = (
  name: string,
  baseUrl: string,
): ResolvedProviderConfig => ({
  apiKey: `${name}-key`,
  authType: "authorization",
  baseUrl,
  name,
  type: "openai-compatible",
})

const createCopilotModels = (ids: Array<string>): ModelsResponse => ({
  object: "list",
  data: ids.map((id) => ({
    capabilities: {
      family: "gpt",
      limits: {
        max_context_window_tokens: 200_000,
      },
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
    vendor: "openai",
    version: "test",
  })),
})

const fetchMock = mock((url: string | URL | Request, _init?: RequestInit) => {
  const requestUrl =
    typeof url === "string" ? url
    : url instanceof URL ? url.toString()
    : url.url

  if (requestUrl === "https://bad.example/v1/models") {
    return Promise.resolve(new Response("upstream failed", { status: 502 }))
  }

  if (
    requestUrl
    === "https://chatgpt.com/backend-api/codex/models?simulate=rate-limit"
  ) {
    return Promise.resolve(
      Response.json(
        { error: { message: "rate limited" } },
        {
          status: 429,
          headers: { "x-request-id": "codex-request-123" },
        },
      ),
    )
  }

  if (
    requestUrl
    === "https://chatgpt.com/backend-api/codex/models?verify=lazy-log"
  ) {
    const response = Response.json({ object: "list", data: [] })
    const originalClone = response.clone.bind(response)
    Object.defineProperty(response, "clone", {
      value: () => {
        codexModelsResponseCloneCount += 1
        return originalClone()
      },
    })
    return Promise.resolve(response)
  }

  const providerModelIds: Record<string, string> = {
    "first.example": "first-model",
    "second.example": "second-model",
  }
  const providerModelId =
    providerModelIds[new URL(requestUrl).host] ?? "qwen-plus"

  return Promise.resolve(
    Response.json({
      object: "list",
      data: [
        {
          id: providerModelId,
          name: providerModelId,
          object: "model",
        },
        {
          id: "",
          object: "model",
        },
      ],
    }),
  )
})

function createApp() {
  const app = new Hono()
  app.route("/api/admin", adminApiRoutes)
  app.route("/v1/models", modelRoutes)
  app.route("/:provider/v1/models", providerModelRoutes)
  return app
}

beforeEach(() => {
  enabledProviders = []
  providerConfigs = {}
  accountsManager.getFirstAccountModels = () => undefined
  codexModelsResponseCloneCount = 0
  resetLoggerRuntimeForTests(undefined, "info")
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  accountsManager.getFirstAccountModels = originalGetFirstAccountModels
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
  resetLoggerRuntimeForTests()
})

describe("model routes", () => {
  test("aggregates Copilot and provider models without mutating account models", async () => {
    const copilotModels = createCopilotModels(["gpt-5-mini"])
    accountsManager.getFirstAccountModels = () => copilotModels
    enabledProviders = ["dash"]
    providerConfigs = {
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "dash/qwen-plus",
    ])
    expect(copilotModels.data.map((model) => model.id)).toEqual(["gpt-5-mini"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://dash.example/v1/models")
  })

  test("keeps Copilot models first and provider models in provider order", async () => {
    accountsManager.getFirstAccountModels = () =>
      createCopilotModels(["gpt-5-mini", "gpt-5"])
    enabledProviders = ["second", "first"]
    providerConfigs = {
      first: createProviderConfig("first", "https://first.example"),
      second: createProviderConfig("second", "https://second.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "gpt-5",
      "second/second-model",
      "first/first-model",
    ])
  })

  test("returns provider models in provider-only mode and skips failed providers", async () => {
    enabledProviders = ["bad", "dash"]
    providerConfigs = {
      bad: createProviderConfig("bad", "https://bad.example"),
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual(["dash/qwen-plus"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("adds built-in Codex provider models without calling upstream", async () => {
    enabledProviders = ["codex"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.4")
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("proxies remote models through the configured Codex base URL", async () => {
    providerConfigs = {
      codex: {
        apiKey: "configured-token",
        authType: "oauth2",
        baseUrl: "https://codex.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "loaded-token"
    state.codexAccountId = "loaded-account"

    const response = await createApp().request(
      "/v1/models?client_version=1.2.3",
      {
        headers: {
          accept: "*/*",
          authorization: "Bearer client-token",
          "chatgpt-account-id": "client-account",
          "user-agent": "Codex/1.2.3",
        },
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual(["qwen-plus", ""])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://codex.example/backend-api/codex/models?client_version=1.2.3",
    )

    const requestInit = fetchMock.mock.calls[0]?.[1]
    const upstreamHeaders = new Headers(requestInit?.headers)
    expect(requestInit?.method).toBe("GET")
    expect(upstreamHeaders.get("authorization")).toBe("Bearer loaded-token")
    expect(upstreamHeaders.get("chatgpt-account-id")).toBe("loaded-account")
    expect(upstreamHeaders.get("user-agent")).toBe("Codex/1.2.3")
    expect(upstreamHeaders.get("accept")).toBe("*/*")
  })

  test("does not clone Codex models responses when debug logging is disabled", async () => {
    providerConfigs = {
      codex: {
        apiKey: "configured-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "loaded-token"
    state.codexAccountId = "loaded-account"

    const response = await createApp().request("/v1/models?verify=lazy-log", {
      headers: { "user-agent": "Codex/1.2.3" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ object: "list", data: [] })
    expect(codexModelsResponseCloneCount).toBe(0)
  })

  test("returns not found for Codex clients when the provider is unavailable", async () => {
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex/1.2.3" },
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'codex' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("preserves remote Codex model error responses", async () => {
    providerConfigs = {
      codex: {
        apiKey: "configured-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "loaded-token"
    state.codexAccountId = "loaded-account"

    const response = await createApp().request(
      "/v1/models?simulate=rate-limit",
      { headers: { "user-agent": "codex/1.2.3" } },
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("x-request-id")).toBe("codex-request-123")
    expect(await response.json()).toEqual({
      error: { message: "rate limited" },
    })
  })

  test("admin aggregated models mirror public runtime aggregation", async () => {
    accountsManager.getFirstAccountModels = () =>
      createCopilotModels(["gpt-5-mini"])
    enabledProviders = ["bad", "dash", "codex"]
    providerConfigs = {
      bad: createProviderConfig("bad", "https://bad.example"),
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const app = createApp()
    const publicResponse = await app.request("/v1/models")
    const adminResponse = await app.request("/api/admin/models/aggregated")

    expect(publicResponse.status).toBe(200)
    expect(adminResponse.status).toBe(200)

    const publicBody = await publicResponse.json()
    const adminBody = await adminResponse.json()
    expect(adminBody).toEqual(publicBody)

    const body = adminBody as { data: Array<{ id: string }> }
    const modelIds = body.data.map((model) => model.id)
    expect(modelIds).toContain("gpt-5-mini")
    expect(modelIds).toContain("dash/qwen-plus")
    expect(modelIds).toContain("codex/gpt-5.4")
  })

  test("forwards Codex clients on the provider-scoped models route", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://codex.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request(
      "/codex/v1/models?client=codex",
      {
        headers: {
          accept: "*/*",
          "user-agent": "codex-tui/0.144.1",
        },
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://codex.example/backend-api/codex/models?client=codex",
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
  })

  test("returns built-in Codex models on the provider route without Codex UA", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/codex/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("gpt-5.4")
    expect(body.data.map((model) => model.id)).toContain("gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
