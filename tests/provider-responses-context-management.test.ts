import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { ResponsesResult } from "../src/services/copilot/create-responses"

const actualConfigModule = await import("../src/lib/config")
const actualTokenUsageModule = await import("../src/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null

const noopTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: () => providerConfig,
  resolveMappedModel: (model: string) => model,
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { responsesRoutes } = await import("../src/routes/responses/route")
const { providerResponsesRoutes } =
  await import("../src/routes/provider/responses/route")
const { responsesUtilsDependencies } =
  await import("../src/routes/responses/utils")

const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }
const originalFetch = globalThis.fetch

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

const parseJsonRequestBody = (body: unknown): unknown => {
  if (typeof body !== "string") {
    throw new Error("Expected JSON string request body")
  }

  return JSON.parse(body) as unknown
}

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const body = parseJsonRequestBody(init?.body) as { model: string }
  return Promise.resolve(
    new Response(JSON.stringify(createResponsesResult(body.model)), {
      headers: {
        "content-type": "application/json",
      },
    }),
  )
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  app.route("/:provider/v1/responses", providerResponsesRoutes)
  app.route("/:provider/responses", providerResponsesRoutes)
  return app
}

beforeEach(() => {
  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://openai-responses.example",
    models: {
      "gpt-test": {},
    },
    name: "openai",
    type: "openai-responses",
  }

  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

describe("provider Responses context management", () => {
  test("does not add context management or compact provider Responses input by default", async () => {
    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("adds context management and keeps only the latest compaction carrier when enabled", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<Record<string, unknown>>
    }

    expect(body.context_management).toEqual([
      {
        compact_threshold: 160000,
        type: "compaction",
      },
    ])
    expect(body.input).toEqual([
      {
        encrypted_content: "cipher",
        id: "compaction-1",
        type: "compaction",
      },
      {
        content: "latest",
        role: "user",
      },
    ])
  })

  test("disables context management for gpt-5.6 models even when responses is enabled", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-5.6-sol",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("disables context management for gpt-6 models even when responses is enabled", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-6",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("supports the provider-scoped responses route", async () => {
    const app = createApp()
    const response = await app.request("/openai/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://openai-responses.example/v1/responses",
    )

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      model: string
    }
    expect(body.model).toBe("gpt-test")
  })

  test("supports the unversioned provider-scoped responses route", async () => {
    const response = await createApp().request("/openai/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-test" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://openai-responses.example/v1/responses",
    )
  })

  test("converts malformed provider response bodies into gateway errors", async () => {
    const response = await createApp().request("/openai/responses", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { type: string } }
    expect(body.error.type).toBe("error")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
