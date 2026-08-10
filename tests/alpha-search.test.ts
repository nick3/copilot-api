import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type {
  ResponsesPayload,
  ResponsesResult,
} from "../src/services/copilot/create-responses"
import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")

let codexProviderConfig: ResolvedProviderConfig | null = null
let openrouterProviderConfig: ResolvedProviderConfig | null = null
let alphaSearchCodexPriorityEnabled = true
let alphaSearchModel: string | undefined = "gpt-5-mini"
let modelMappings: Record<string, string> = {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => {
    if (provider === "codex") return codexProviderConfig
    if (provider === "openrouter") return openrouterProviderConfig
    return null
  },
  getRawProviderConfig: (provider: string) => {
    if (provider === "codex") return codexProviderConfig
    if (provider === "openrouter") return openrouterProviderConfig
    return null
  },
  getAlphaSearchModel: () => alphaSearchModel,
  isAlphaSearchCodexPriorityEnabled: () => alphaSearchCodexPriorityEnabled,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

const { state } = await import("../src/lib/state")
const { accountsManager } = await import("../src/lib/accounts-manager")
const { resetLoggerRuntimeForTests } = await import("../src/lib/logger")
const { forwardCodexAlphaSearch, resolveCodexAlphaSearchUrl } =
  await import("../src/services/codex/alpha-search")
const { forwardCodexModels, getModels, resolveCodexModelsUrl } =
  await import("../src/services/codex/get-models")
const { alphaSearchRoutes } = await import("../src/routes/alpha-search/route")
const { alphaSearchResponsesDependencies, resetAlphaSearchState } =
  await import("../src/routes/alpha-search/alpha-search-responses")
const { providerAlphaSearchRoutes } =
  await import("../src/routes/provider/alpha-search/route")

const originalFetch = globalThis.fetch
const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId
const originalGetFirstAccountModels =
  accountsManager.getFirstAccountModels.bind(accountsManager)
const originalResponsesDependencies = { ...alphaSearchResponsesDependencies }
let copilotModels: ModelsResponse = { object: "list", data: [] }
let trackAlphaSearchResponseClone = false
let alphaSearchResponseCloneCount = 0
const alphaSearchPayload = {
  id: "search-request-id",
  model: "gpt-5.6-sol",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "search query",
        },
      ],
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn-id",
      },
    },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "searching",
        },
      ],
      phase: "commentary",
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn-id",
      },
    },
  ],
  commands: {
    open: [{ ref_id: "turn0search0" }],
    response_length: "long",
  },
  settings: {
    allowed_callers: ["direct"],
    external_web_access: false,
  },
  max_output_tokens: 10_000,
}

function createFallbackPayload(
  commands: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "fallback-session",
    model: "gpt-5.6-sol",
    input: "Run the requested search operations.",
    commands,
    settings: { external_web_access: "live" },
    max_output_tokens: 4096,
    ...overrides,
  }
}

function createModel(id: string, supportedEndpoints: Array<string>): Model {
  return {
    capabilities: {
      family: "gpt",
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
    supported_endpoints: supportedEndpoints,
    vendor: "test",
    version: "1",
  }
}

function createResponsesResult(
  options: {
    answer?: string
    citations?: boolean
    sources?: Array<{ title?: string; url: string }>
  } = {},
): ResponsesResult {
  const answer = options.answer ?? "Grounded search answer."
  const sources = options.sources ?? [
    { title: "Example", url: "https://example.com/result" },
  ]
  return {
    id: "resp-alpha-search",
    object: "response",
    created_at: 0,
    model: "gpt-5.6-sol",
    output: [
      {
        type: "web_search_call",
        id: "search-call",
        status: "completed",
        action: {
          type: "search",
          query: "search query",
          sources: sources.map(({ url }) => ({ type: "url", url })),
        },
      },
      {
        id: "message-alpha-search",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: answer,
            annotations:
              options.citations === false ?
                []
              : sources.map((source) => ({
                  type: "url_citation",
                  title: source.title,
                  url: source.url,
                  start_index: 0,
                  end_index: answer.length,
                })),
          },
        ],
      },
    ],
    output_text: answer,
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "required",
    tools: [],
    top_p: null,
  }
}

const dispatchResponsesMock = mock(
  (_context: unknown, _payload: ResponsesPayload): Promise<Response> =>
    Promise.resolve(Response.json(createResponsesResult())),
)
const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const response = new Response(
      JSON.stringify({ results: [{ title: "result" }] }),
      {
        headers: {
          "content-type": "application/json",
          "x-upstream": "codex",
        },
        status: 200,
      },
    )
    if (trackAlphaSearchResponseClone) {
      const originalClone = response.clone.bind(response)
      Object.defineProperty(response, "clone", {
        value: () => {
          alphaSearchResponseCloneCount += 1
          return originalClone()
        },
      })
    }
    return Promise.resolve(response)
  },
)

function createApp() {
  const app = new Hono()
  app.route("/alpha/search", alphaSearchRoutes)
  app.route("/v1/alpha/search", alphaSearchRoutes)
  app.route("/:provider/v1/alpha/search", providerAlphaSearchRoutes)
  return app
}

function requestFallback(
  body: unknown,
  path = "/alpha/search",
): Promise<Response> {
  codexProviderConfig = null
  return Promise.resolve(
    createApp().request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  alphaSearchCodexPriorityEnabled = true
  alphaSearchModel = "gpt-5-mini"
  modelMappings = {}
  codexProviderConfig = {
    apiKey: "unused-provider-key",
    authType: "oauth2",
    baseUrl: "https://chatgpt.com/backend-api",
    name: "codex",
    type: "openai-responses",
  }
  openrouterProviderConfig = {
    apiKey: "openrouter-key",
    authType: "authorization",
    baseUrl: "https://openrouter.example",
    name: "openrouter",
    type: "openai-compatible",
  }
  state.codexAccessToken = "codex-access-token"
  state.codexAccountId = "account-123"
  copilotModels = {
    object: "list",
    data: [
      createModel("gpt-5.6-sol", ["/responses"]),
      createModel("gpt-5-mini", ["/responses"]),
    ],
  }
  accountsManager.getFirstAccountModels = () => copilotModels
  dispatchResponsesMock.mockClear()
  alphaSearchResponsesDependencies.dispatchResponses =
    dispatchResponsesMock as never
  alphaSearchResponsesDependencies.findEndpointModel = (model) =>
    copilotModels.data.find((candidate) => candidate.id === model)
  alphaSearchResponsesDependencies.now = () =>
    Date.parse("2026-08-03T12:00:00.000Z")
  alphaSearchResponsesDependencies.resolveMappedModel = (model) =>
    modelMappings[model] ?? model
  resetAlphaSearchState()
  trackAlphaSearchResponseClone = false
  alphaSearchResponseCloneCount = 0
  resetLoggerRuntimeForTests(undefined, "info")
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
  accountsManager.getFirstAccountModels = originalGetFirstAccountModels
  Object.assign(alphaSearchResponsesDependencies, originalResponsesDependencies)
  resetAlphaSearchState()
  resetLoggerRuntimeForTests()
  openrouterProviderConfig = null
})

describe("Codex alpha search URL", () => {
  test("builds the upstream URL and preserves query parameters", () => {
    expect(
      resolveCodexAlphaSearchUrl("http://localhost/alpha/search?q=bun&page=2"),
    ).toBe("https://chatgpt.com/backend-api/codex/alpha/search?q=bun&page=2")
  })

  test("uses a configured Codex API base URL", () => {
    expect(
      resolveCodexAlphaSearchUrl(
        "/alpha/search?limit=5",
        "https://codex.example/backend-api/codex/",
      ),
    ).toBe("https://codex.example/backend-api/codex/alpha/search?limit=5")
  })
})

describe("Codex models forwarding", () => {
  test("uses the default Codex models URL and preserves query parameters", () => {
    expect(
      resolveCodexModelsUrl("http://localhost/v1/models?client=codex"),
    ).toBe("https://chatgpt.com/backend-api/codex/models?client=codex")
  })

  test("forwards model requests with Codex auth headers", async () => {
    await forwardCodexModels(
      "http://localhost/v1/models?client=codex",
      new Headers({ accept: "*/*" }),
      "https://codex.example/backend-api/codex/",
    )

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://codex.example/backend-api/codex/models?client=codex",
    )
    expect(init?.method).toBe("GET")
    const headers = new Headers(init?.headers)
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
  })

  test("keeps the built-in Codex model catalog available", () => {
    const models = getModels()
    expect(models.object).toBe("list")
    expect(models.data.map((model) => model.id)).toContain("gpt-5.6-sol")
  })
})

describe("Codex alpha search forwarding", () => {
  test("forwards POST body, query, and Codex auth headers", async () => {
    if (!codexProviderConfig) {
      throw new Error("Expected Codex provider config")
    }
    codexProviderConfig.baseUrl = "https://codex.example/backend-api"

    const response = await createApp().request(
      "/alpha/search?q=typescript&limit=5",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: "Bearer client-token",
          "content-type": "application/json",
          cookie: "session=test-cookie",
          originator: "codex-tui",
          "user-agent": "codex-tui/test",
          "x-client-header": "kept",
        },
        body: JSON.stringify(alphaSearchPayload),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-upstream")).toBe("codex")
    expect(await response.json()).toEqual({
      results: [{ title: "result" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://codex.example/backend-api/codex/alpha/search?q=typescript&limit=5",
    )
    expect(init?.method).toBe("POST")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("cookie")).toBe("session=test-cookie")
    expect(headers.get("originator")).toBe("codex-tui")
    expect(headers.get("user-agent")).toBe("codex-tui/test")
    expect(headers.get("x-client-header")).toBe("kept")
    expect(await new Response(init?.body).json()).toEqual(alphaSearchPayload)
  })

  test("does not clone Alpha Search responses when debug logging is disabled", async () => {
    trackAlphaSearchResponseClone = true

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ results: [{ title: "result" }] })
    expect(alphaSearchResponseCloneCount).toBe(0)
  })

  test("does not expose alpha search over GET", async () => {
    const response = await createApp().request("/alpha/search?q=bun")

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("supports the v1 alpha search alias", async () => {
    const response = await createApp().request("/v1/alpha/search?q=bun", {
      method: "POST",
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/alpha/search?q=bun")
  })

  test("supports the provider-scoped alpha search route", async () => {
    const response = await createApp().request(
      "/codex/v1/alpha/search?q=provider",
      {
        method: "POST",
        body: JSON.stringify(alphaSearchPayload),
      },
    )

    expect(response.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/alpha/search?q=provider",
    )
  })

  test("proxies non-codex providers on the provider-scoped alpha search route", async () => {
    const response = await createApp().request(
      "/openrouter/v1/alpha/search?q=generic",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
        },
        body: JSON.stringify(alphaSearchPayload),
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.example/v1/alpha/search?q=generic")
    expect(init?.method).toBe("POST")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.get("content-type")).toBe("application/json")
    expect(await new Response(init?.body).json()).toEqual(alphaSearchPayload)
  })

  test("logs provider-scoped request and response bodies at debug level", async () => {
    resetLoggerRuntimeForTests(undefined, "debug")
    trackAlphaSearchResponseClone = true

    const response = await createApp().request(
      "/openrouter/v1/alpha/search?q=debug",
      {
        method: "POST",
        body: JSON.stringify(alphaSearchPayload),
      },
    )

    expect(response.status).toBe(200)
    expect(alphaSearchResponseCloneCount).toBe(1)
  })

  test("returns 404 for an unavailable provider-scoped alpha search", async () => {
    openrouterProviderConfig = null

    const response = await createApp().request("/openrouter/v1/alpha/search", {
      method: "POST",
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'openrouter' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("converts provider alpha search failures into gateway errors", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(new Error("provider alpha failed")),
    )

    const response = await createApp().request("/openrouter/v1/alpha/search", {
      method: "POST",
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { message: "provider alpha failed", type: "error" },
    })
  })

  test("reads request and response bodies when debug logging is enabled", async () => {
    resetLoggerRuntimeForTests(undefined, "debug")
    trackAlphaSearchResponseClone = true

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [{ title: "result" }],
    })
    expect(alphaSearchResponseCloneCount).toBe(1)
  })

  test("preserves non-JSON upstream responses when debug logging is enabled", async () => {
    resetLoggerRuntimeForTests(undefined, "debug")
    const nonJsonFetchMock = mock(
      (): Promise<Response> =>
        Promise.resolve(new Response("upstream failed", { status: 502 })),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      nonJsonFetchMock as unknown as typeof fetch

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(502)
    expect(await response.text()).toBe("upstream failed")
  })

  test("adds JSON content type when a request body has none", async () => {
    await forwardCodexAlphaSearch(
      new Request("http://localhost/alpha/search", {
        method: "POST",
        body: new Uint8Array([123, 125]),
      }),
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    )
  })

  test("falls back when the Codex provider is unavailable", async () => {
    codexProviderConfig = null

    const response = await createApp().request("/alpha/search?q=bun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { output: string }).output).toContain(
      "unavailable or expired",
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("converts missing Codex access token failures into gateway errors", async () => {
    state.codexAccessToken = undefined

    const response = await createApp().request("/alpha/search?q=bun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alphaSearchPayload),
    })

    expect(response.status).toBe(500)
    const body = (await response.json()) as {
      error: { message: string; type: string }
    }
    expect(body.error.message).toBe("Codex access token is not loaded")
    expect(body.error.type).toBe("error")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("Alpha search Responses adapter", () => {
  test("dispatches live retrieval through the shared Responses handler", async () => {
    codexProviderConfig = null
    modelMappings = { "gpt-5.6-sol": "gpt-search-mapped" }
    copilotModels = {
      object: "list",
      data: [createModel("gpt-search-mapped", ["/responses"])],
    }

    const response = await createApp().request("/v1/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createFallbackPayload(
          {
            search_query: [{ q: "latest Bun", recency: 7 }],
            finance: [{ ticker: "AMD", type: "equity", market: "USA" }],
            weather: [{ location: "Shanghai" }],
            response_length: "long",
          },
          {
            reasoning: { effort: "high", summary: "concise" },
            settings: {
              external_web_access: "live",
              search_context_size: "high",
              filters: { allowed_domains: ["bun.sh"] },
            },
          },
        ),
      ),
    })

    expect(response.status).toBe(200)
    expect(dispatchResponsesMock).toHaveBeenCalledTimes(1)
    const payload = dispatchResponsesMock.mock.calls[0]?.[1]
    expect(payload?.model).toBe("gpt-search-mapped")
    expect(payload?.stream).toBe(false)
    expect(payload?.store).toBe(false)
    expect(payload?.tool_choice).toBe("required")
    expect(payload?.prompt_cache_key).toBeString()
    expect(payload?.tools).toEqual([
      {
        type: "web_search",
        filters: { allowed_domains: ["bun.sh"] },
        search_context_size: "high",
      },
    ])
    expect(payload?.input).toContain('"operation": "finance"')
    expect(payload?.input).toContain('"operation": "weather"')

    const body = (await response.json()) as {
      output: string
      results: Array<Record<string, string>>
    }
    expect(body.output).toContain("Grounded search answer.")
    expect(body.results[0]).toMatchObject({
      domain: "example.com",
      ref_id: "turn0search0",
      title: "Example",
      url: "https://example.com/result",
    })
  })

  test("redirects Messages-only models to alphaSearchModel", async () => {
    codexProviderConfig = null
    alphaSearchModel = "gpt-search"
    copilotModels = {
      object: "list",
      data: [
        createModel("gpt-5.6-sol", ["/chat/completions"]),
        createModel("gpt-search", ["/responses"]),
      ],
    }

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createFallbackPayload({ search_query: [{ q: "redirect" }] }),
      ),
    })

    expect(response.status).toBe(200)
    expect(dispatchResponsesMock.mock.calls[0]?.[1].model).toBe("gpt-search")
  })

  test("rejects unusable alphaSearchModel settings", async () => {
    codexProviderConfig = null
    copilotModels = {
      object: "list",
      data: [createModel("gpt-5.6-sol", ["/chat/completions"])],
    }

    alphaSearchModel = undefined
    const disabled = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "disabled" }] }),
    )
    expect(disabled.status).toBe(400)
    expect(
      ((await disabled.json()) as { error: { message: string } }).error.message,
    ).toContain("alphaSearchModel is disabled")

    alphaSearchModel = "not-a-responses-model"
    const invalid = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "invalid" }] }),
    )
    expect(invalid.status).toBe(400)
    expect(
      ((await invalid.json()) as { error: { message: string } }).error.message,
    ).toContain("does not support the Responses endpoint")
  })

  test("returns 404 for an explicit unavailable Codex alias", async () => {
    codexProviderConfig = null
    const response = await requestFallback(
      createFallbackPayload(
        { search_query: [{ q: "explicit Codex" }] },
        { model: "codex/gpt-5.6-sol" },
      ),
    )

    expect(response.status).toBe(404)
    expect(
      ((await response.json()) as { error: { message: string } }).error.message,
    ).toBe("Provider 'codex' not found or disabled")
  })

  test("keeps non-live and unsupported commands local", async () => {
    codexProviderConfig = null
    const response = await createApp().request("/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createFallbackPayload(
          {
            image_query: [{ q: "diagram" }],
            screenshot: [{ ref_id: "turn0view0", pageno: 0 }],
            search_query: [{ q: "must not run" }],
            time: [{ utc_offset: "+03:00" }],
          },
          { settings: { external_web_access: "cached" } },
        ),
      ),
    })

    const body = (await response.json()) as { output: string }
    expect(response.status).toBe(200)
    expect(dispatchResponsesMock).not.toHaveBeenCalled()
    expect(body.output).toContain("Time at UTC+03:00: 2026-08-03 15:00:00")
    expect(body.output).toContain("image_query")
    expect(body.output).toContain("screenshot")
    expect(body.output).toContain("supports live retrieval only")
  })

  test("preserves provider aliases when dispatching native Responses", async () => {
    codexProviderConfig = null
    alphaSearchCodexPriorityEnabled = false
    if (!openrouterProviderConfig) {
      throw new Error("Expected OpenRouter provider config")
    }
    openrouterProviderConfig.type = "openai-responses"

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createFallbackPayload(
          { search_query: [{ q: "provider search" }] },
          { model: "openrouter/search-model" },
        ),
      ),
    })

    expect(response.status).toBe(200)
    expect(dispatchResponsesMock.mock.calls[0]?.[1].model).toBe(
      "openrouter/search-model",
    )
  })

  test("returns dispatcher failures with their retry headers", async () => {
    codexProviderConfig = null
    dispatchResponsesMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json(
          { error: { message: "quota exhausted", type: "rate_limit_error" } },
          { status: 429, headers: { "retry-after": "12" } },
        ),
      ),
    )

    const response = await createApp().request("/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createFallbackPayload({ search_query: [{ q: "retry" }] }),
      ),
    })

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("12")
  })

  test("validates fallback payloads before dispatch", async () => {
    codexProviderConfig = null
    const invalidJson = await createApp().request("/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    expect(invalidJson.status).toBe(400)

    const missingModel = await requestFallback({
      id: "missing-model",
      commands: {},
    })
    expect(missingModel.status).toBe(400)

    const invalidOffset = await requestFallback(
      createFallbackPayload({ time: [{ utc_offset: "UTC+3" }] }),
    )
    expect(invalidOffset.status).toBe(400)
    expect(dispatchResponsesMock).not.toHaveBeenCalled()
  })

  test("prefers cited sources and falls back to action sources", async () => {
    const citedResult = createResponsesResult({
      sources: [
        { title: "Cited", url: "https://example.com/cited" },
        { title: "Uncited", url: "https://example.com/uncited" },
      ],
    })
    const message = citedResult.output[1] as {
      content: Array<{ annotations?: Array<unknown> }>
    }
    message.content[0].annotations = message.content[0].annotations?.slice(0, 1)
    dispatchResponsesMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json(citedResult)),
    )

    const citedResponse = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "cited" }] }),
    )
    const citedBody = (await citedResponse.json()) as {
      results: Array<{ url: string }>
    }
    expect(citedBody.results.map(({ url }) => url)).toEqual([
      "https://example.com/cited",
    ])

    dispatchResponsesMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json(
          createResponsesResult({
            citations: false,
            sources: [{ url: "https://example.com/action-source" }],
          }),
        ),
      ),
    )
    const actionResponse = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "action" }] }),
    )
    const actionBody = (await actionResponse.json()) as {
      results: Array<Record<string, string>>
    }
    expect(actionBody.results[0]).toMatchObject({
      ref_id: "turn1search0",
      title: "https://example.com/action-source",
      url: "https://example.com/action-source",
    })
  })

  test("opens, finds, and clicks through bounded cached views", async () => {
    const results = [
      createResponsesResult({
        answer: "Search answer",
        sources: [{ title: "Page A", url: "https://example.com/a" }],
      }),
      createResponsesResult({
        answer:
          "zero\nneedle line\ntwo\n[Page B](https://example.com/b)\n([Page A](https://example.com/a))",
        sources: [{ title: "Page A", url: "https://example.com/a" }],
      }),
      createResponsesResult({
        answer: "Clicked page text",
        sources: [{ title: "Page B", url: "https://example.com/b" }],
      }),
    ]
    let responseIndex = 0
    dispatchResponsesMock.mockImplementation(() =>
      Promise.resolve(
        Response.json(results[responseIndex++] ?? results.at(-1)!),
      ),
    )

    const search = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "page a" }] }),
    )
    expect(
      ((await search.json()) as { results: Array<{ ref_id: string }> })
        .results[0]?.ref_id,
    ).toBe("turn0search0")

    const opened = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0search0" }] }),
    )
    const openedOutput = ((await opened.json()) as { output: string }).output
    expect(openedOutput).toContain("Open turn1view0")
    expect(openedOutput).toContain("L1: needle line")
    expect(openedOutput).toContain(
      "[0] Page B — https://example.com/b (turn1search0)",
    )

    const found = await requestFallback(
      createFallbackPayload({
        find: [{ ref_id: "turn1view0", pattern: "needle" }],
      }),
    )
    expect(((await found.json()) as { output: string }).output).toContain(
      'Find results for "needle" in turn1view0',
    )

    const clicked = await requestFallback(
      createFallbackPayload({ click: [{ ref_id: "turn1view0", id: 0 }] }),
    )
    expect(((await clicked.json()) as { output: string }).output).toContain(
      "Clicked page text",
    )
    expect(dispatchResponsesMock).toHaveBeenCalledTimes(3)

    const cachedClick = await requestFallback(
      createFallbackPayload({ click: [{ ref_id: "turn1view0", id: 0 }] }),
    )
    expect(((await cachedClick.json()) as { output: string }).output).toContain(
      "Clicked page text",
    )
    expect(dispatchResponsesMock).toHaveBeenCalledTimes(3)
  })

  test("isolates and expires session references", async () => {
    await requestFallback(
      createFallbackPayload({ search_query: [{ q: "session reference" }] }),
    )

    const crossSession = await requestFallback(
      createFallbackPayload(
        { open: [{ ref_id: "turn0search0" }] },
        { id: "different-session" },
      ),
    )
    expect(
      ((await crossSession.json()) as { output: string }).output,
    ).toContain("unavailable or expired")
    expect(dispatchResponsesMock).toHaveBeenCalledTimes(1)

    alphaSearchResponsesDependencies.now = () =>
      Date.parse("2026-08-03T13:00:00.000Z")
    const expired = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0search0" }] }),
    )
    expect(((await expired.json()) as { output: string }).output).toContain(
      "unavailable or expired",
    )
  })

  test("enforces URL reference and snapshot ceilings", async () => {
    const manySources = Array.from({ length: 257 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://example.com/source-${index}`,
    }))
    dispatchResponsesMock.mockImplementation(() =>
      Promise.resolve(
        Response.json(createResponsesResult({ sources: manySources })),
      ),
    )
    const manySourceResponse = await requestFallback(
      createFallbackPayload({ search_query: [{ q: "many sources" }] }),
    )
    expect(
      ((await manySourceResponse.json()) as { results: Array<unknown> })
        .results,
    ).toHaveLength(256)
    const evictedReference = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0search0" }] }),
    )
    expect(
      ((await evictedReference.json()) as { output: string }).output,
    ).toContain("unavailable or expired")

    resetAlphaSearchState()
    dispatchResponsesMock.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          createResponsesResult({ answer: "Opened text", sources: [] }),
        ),
      ),
    )
    for (let index = 0; index < 17; index += 1) {
      await requestFallback(
        createFallbackPayload({
          open: [{ ref_id: `https://example.com/page-${index}` }],
        }),
      )
    }
    const evictedSnapshot = await requestFallback(
      createFallbackPayload({ open: [{ ref_id: "turn0view0" }] }),
    )
    expect(
      ((await evictedSnapshot.json()) as { output: string }).output,
    ).toContain("unavailable or expired")
  })
})
