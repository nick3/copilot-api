import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"

import "./shared-admin-db-test-home"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { RequestLogRow } from "../src/lib/request-history"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../src/routes/messages/anthropic-types"
import type { ResponsesResult } from "../src/services/copilot/create-responses"
import type { Model } from "../src/services/copilot/get-models"

const actualRateLimitModule = await import("../src/lib/rate-limit")
const actualStateModule = await import("../src/lib/state")
const actualTokenModule = await import("../src/lib/token")
const actualTokenUsageModule = await import("../src/lib/token-usage")
const { accountsManager } = await import("../src/lib/accounts-manager")
const { getAdminDb } = await import("../src/lib/admin-db")
const { mergeConfigWithDefaults } = await import("../src/lib/config")
const { PATHS } = await import("../src/lib/paths")

const noopTokenUsageRecorder = () => {}
const checkRateLimit = mock(async () => {})
const buildModel = (id: string): Model => ({
  capabilities: {
    family: "test",
    limits: {
      max_output_tokens: 8192,
      max_prompt_tokens: 200_000,
    },
    object: "model_capabilities",
    supports: {
      streaming: true,
    },
    tokenizer: "o200k_base",
    type: "chat",
  },
  id,
  model_picker_enabled: true,
  name: id,
  object: "model",
  preview: false,
  supported_endpoints: ["/v1/messages", "/responses"],
  vendor: "test",
  version: "test",
})

const searchProviderConfig = (): ResolvedProviderConfig => ({
  name: "search",
  type: "openai-responses",
  baseUrl: "https://provider.example",
  apiKey: "provider-key",
  authType: "authorization",
  models: {
    "gpt-search": {
      toolContentSupportType: [],
    },
  },
})

const dashProviderConfig = (): ResolvedProviderConfig => ({
  name: "dash",
  type: "openai-compatible",
  baseUrl: "https://dash.example/compatible-mode",
  apiKey: "dash-key",
  authType: "authorization",
  models: {
    "qwen-plus": {
      toolContentSupportType: [],
    },
  },
})

const writeTestConfig = (config: Record<string, unknown>): void => {
  fs.writeFileSync(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()
}

const writeProviderConfig = (
  providers: Record<string, ResolvedProviderConfig> = {
    search: searchProviderConfig(),
  },
  options: { messageApiWebSearchModel?: string } = {
    messageApiWebSearchModel: "gpt-5-mini",
  },
): void => {
  writeTestConfig({
    auth: { apiKeys: [] },
    providers,
    useResponsesApiWebSearch: true,
    useResponsesApiWebSocket: false,
    ...(options.messageApiWebSearchModel !== undefined ?
      { messageApiWebSearchModel: options.messageApiWebSearchModel }
    : {}),
  })
}

await mock.module("~/lib/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit,
}))

await mock.module("~/lib/state", () => ({
  ...actualStateModule,
  state: actualStateModule.state,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { providerMessageRoutes } =
  await import("../src/routes/provider/messages/route")
const { messageRoutes } = await import("../src/routes/messages/route")
const { state } = await import("../src/lib/state")
const { responsesUtilsDependencies } =
  await import("../src/routes/responses/utils")

const originalGithubToken = state.githubToken
const originalCopilotToken = state.copilotToken
const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId
const originalManualApprove = state.manualApprove
const originalTokenBasedBilling = state.tokenBasedBilling
const originalVerbose = state.verbose
const originalGetFirstAccountModels =
  accountsManager.getFirstAccountModels.bind(accountsManager)
const originalSelectAccountForRequest =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalizeQuota =
  accountsManager.finalizeQuota.bind(accountsManager)
const originalMarkAccountFailed =
  accountsManager.markAccountFailed.bind(accountsManager)
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const makeResponsesResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult =>
  ({
    id: "resp_provider_search",
    object: "response",
    created_at: 0,
    model: "gpt-search",
    output: [
      { type: "web_search_call", action: { query: "node lts version" } },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Node.js 24 is the latest LTS.",
            annotations: [
              {
                type: "url_citation",
                url: "https://nodejs.org",
                title: "Node.js",
              },
            ],
          },
        ],
      },
    ],
    output_text: "",
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: null,
    tools: [],
    top_p: null,
    ...overrides,
  }) as unknown as ResponsesResult

const makePlainResponsesResult = (): ResponsesResult =>
  makeResponsesResult({
    id: "resp_provider_message",
    model: "gpt-5.4",
    output: [
      {
        id: "msg-provider-message",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Hello from Codex.",
            annotations: [],
          },
        ],
      },
    ],
    output_text: "Hello from Codex.",
  })

const makeChatCompletionResponse = () => ({
  id: "chatcmpl-web-search-stripped",
  object: "chat.completion",
  created: 0,
  model: "qwen-plus",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "answer text",
      },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 8,
    completion_tokens: 2,
    total_tokens: 10,
  },
})

const makeResponsesStreamResponse = (body: ResponsesResult) =>
  new Response(
    [
      "event: response.created",
      `data: ${JSON.stringify({
        response: {
          ...body,
          output: [],
          output_text: "",
          usage: null,
        },
        sequence_number: 1,
        type: "response.created",
      })}`,
      "",
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        item: body.output[0],
        output_index: 0,
        sequence_number: 2,
        type: "response.output_item.done",
      })}`,
      "",
      "event: response.output_item.added",
      `data: ${JSON.stringify({
        item: {
          id: "msg-1",
          role: "assistant",
          status: "in_progress",
          type: "message",
        },
        output_index: 1,
        sequence_number: 3,
        type: "response.output_item.added",
      })}`,
      "",
      "event: response.output_text.delta",
      `data: ${JSON.stringify({
        content_index: 0,
        delta: "Node.js 24 is the latest LTS.",
        item_id: "msg-1",
        output_index: 1,
        sequence_number: 4,
        type: "response.output_text.delta",
      })}`,
      "",
      "event: response.output_text.annotation.added",
      `data: ${JSON.stringify({
        annotation: {
          title: "Node.js",
          type: "url_citation",
          url: "https://nodejs.org",
        },
        annotation_index: 0,
        content_index: 0,
        item_id: "msg-1",
        output_index: 1,
        sequence_number: 5,
        type: "response.output_text.annotation.added",
      })}`,
      "",
      "event: response.output_text.done",
      `data: ${JSON.stringify({
        content_index: 0,
        item_id: "msg-1",
        output_index: 1,
        sequence_number: 6,
        text: "Node.js 24 is the latest LTS.",
        type: "response.output_text.done",
      })}`,
      "",
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        item: body.output[1],
        output_index: 1,
        sequence_number: 7,
        type: "response.output_item.done",
      })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({
        response: {
          ...body,
          output: [],
          output_text: "",
        },
        sequence_number: 8,
        type: "response.completed",
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  )

const makeCollectedResponsesStreamResponse = (body: ResponsesResult) => {
  let sequenceNumber = 1
  const chunks = [
    "event: response.created",
    `data: ${JSON.stringify({
      response: {
        ...body,
        output: [],
        output_text: "",
        usage: null,
      },
      sequence_number: sequenceNumber,
      type: "response.created",
    })}`,
    "",
  ]

  body.output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      item.content?.forEach((content, contentIndex) => {
        if (content.type !== "output_text") return

        sequenceNumber += 1
        chunks.push(
          "event: response.output_text.delta",
          `data: ${JSON.stringify({
            content_index: contentIndex,
            delta: content.text,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: sequenceNumber,
            type: "response.output_text.delta",
          })}`,
          "",
        )

        sequenceNumber += 1
        chunks.push(
          "event: response.output_text.done",
          `data: ${JSON.stringify({
            content_index: contentIndex,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: sequenceNumber,
            text: content.text,
            type: "response.output_text.done",
          })}`,
          "",
        )
      })
    }

    sequenceNumber += 1
    chunks.push(
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        item,
        output_index: outputIndex,
        sequence_number: sequenceNumber,
        type: "response.output_item.done",
      })}`,
      "",
    )
  })

  sequenceNumber += 1
  chunks.push(
    "event: response.completed",
    `data: ${JSON.stringify({
      response: {
        ...body,
        output: [],
        output_text: "",
      },
      sequence_number: sequenceNumber,
      type: "response.completed",
    })}`,
    "",
    "data: [DONE]",
    "",
  )

  return new Response(chunks.join("\n"), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

const originalFetch = globalThis.fetch
let nextResponsesAsJson = false
let nextResponsesBody: ResponsesResult | undefined
let responsesStreamFactory: ((body: ResponsesResult) => Response) | undefined

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const urlString =
    typeof url === "string" ? url
    : url instanceof URL ? url.href
    : url.url
  const requestPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as { stream?: boolean })
    : {}

  if (urlString.endsWith("/v1/chat/completions")) {
    return Promise.resolve(
      new Response(JSON.stringify(makeChatCompletionResponse()), {
        headers: { "content-type": "application/json" },
      }),
    )
  }

  const body = nextResponsesBody ?? makeResponsesResult()

  if (
    urlString.endsWith("/responses")
    && requestPayload.stream === true
    && !nextResponsesAsJson
  ) {
    return Promise.resolve(
      responsesStreamFactory?.(body) ?? makeResponsesStreamResponse(body),
    )
  }

  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  )
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/messages", messageRoutes)
  app.route("/:provider/v1/messages", providerMessageRoutes)
  return app
}

const webSearchTool = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
  allowed_domains: ["nodejs.org"],
  user_location: {
    type: "approximate",
    country: "US",
  },
}

const configureCodexProvider = (): void => {
  writeProviderConfig({
    search: searchProviderConfig(),
    codex: {
      name: "codex",
      type: "openai-responses",
      baseUrl: "https://codex.example/backend-api",
      apiKey: "unused",
      authType: "authorization",
      models: {
        "gpt-5.4": {
          toolContentSupportType: [],
        },
      },
    },
  })
}

const createCodexMessagesPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  model: "gpt-5.4",
  ...overrides,
})

beforeEach(() => {
  writeProviderConfig()
  nextResponsesAsJson = false
  nextResponsesBody = undefined
  responsesStreamFactory = undefined
  state.githubToken = undefined
  state.copilotToken = undefined
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  state.manualApprove = false
  state.tokenBasedBilling = true
  state.verbose = false
  accountsManager.getFirstAccountModels = () => ({
    data: [
      buildModel("gpt-search"),
      buildModel("claude-sonnet-4.5"),
      buildModel("qwen-plus"),
    ],
    object: "list",
  })
  accountsManager.selectAccountForRequest = (candidates) =>
    Promise.resolve({
      ok: true,
      account: {
        id: "octocat",
        accountType: "individual",
        addedAt: 0,
        githubToken: "ghu_account",
        copilotToken: "copilot_account",
        vsCodeVersion: "1.0.0",
        premiumRemaining: 10,
        unlimited: false,
      },
      selectedModel: buildModel(candidates[0]?.modelId ?? "gpt-search"),
      endpoint: candidates[0]?.endpoint ?? "/responses",
      costUnits: 0,
      confirmAffinity: mock(() => {}),
      confirmOwnership: mock(() => {}),
      affinityHit: false,
      selectionReason: "affinity_miss",
    })
  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}
  getAdminDb().run("DELETE FROM request_log;")
  checkRateLimit.mockClear()
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
  state.githubToken = originalGithubToken
  state.copilotToken = originalCopilotToken
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
  state.manualApprove = originalManualApprove
  state.tokenBasedBilling = originalTokenBasedBilling
  state.verbose = originalVerbose
  accountsManager.getFirstAccountModels = originalGetFirstAccountModels
  accountsManager.selectAccountForRequest = originalSelectAccountForRequest
  accountsManager.finalizeQuota = originalFinalizeQuota
  accountsManager.markAccountFailed = originalMarkAccountFailed
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
  responsesStreamFactory = undefined
  writeTestConfig({ auth: { apiKeys: [] }, providers: {} })
})

describe("provider messages web_search", () => {
  test("adds context management when provider Messages uses Responses API", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-search",
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      context_management?: unknown
      model: string
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.context_management).toEqual([
      {
        compact_threshold: 170000,
        type: "compaction",
      },
    ])
  })

  test("routes top-level Copilot messages web_search through selected account", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          { role: "system", content: "Prefer official release notes." },
          { role: "user", content: "What is the Node.js LTS?" },
        ],
        model: "claude-sonnet-4.5",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(checkRateLimit).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.githubcopilot.com/responses")

    const upstreamHeaders = new Headers((init as RequestInit).headers)
    expect(upstreamHeaders.get("authorization")).toBe("Bearer copilot_account")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      instructions?: string
      model: string
      stream?: boolean
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.instructions).toContain(
      "Prefer official release notes.",
    )
    expect(upstreamBody.model).toBe("gpt-5-mini")
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])

    const json = (await response.json()) as AnthropicResponse
    expect(json.model).toBe("claude-sonnet-4.5")
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  test("routes top-level Copilot messages web_search to provider/model", async () => {
    writeProviderConfig(undefined, {
      messageApiWebSearchModel: "search/gpt-search",
    })

    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "claude-sonnet-4.5",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(checkRateLimit).toHaveBeenCalledTimes(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
      stream?: boolean
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])

    const json = (await response.json()) as AnthropicResponse
    expect(json.model).toBe("gpt-search")
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])

    const row = getAdminDb()
      .query("SELECT * FROM request_log WHERE client_model = ? LIMIT 1;")
      .get("claude-sonnet-4.5") as RequestLogRow | null
    expect(row?.upstream_endpoint).toBe("/providers/search/messages")
    expect(row?.upstream_model).toBe("gpt-search")
    expect(row?.http_status).toBe(200)
    expect(row?.tokens_input).toBe(12)
    expect(row?.tokens_output).toBe(7)
    expect(row?.tokens_total).toBe(19)
  })

  test("runs pure Anthropic web_search through an openai-responses provider", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        output_config: {
          effort: "medium",
        },
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
      reasoning?: { effort?: string }
      stream?: boolean
      tool_choice?: unknown
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.reasoning?.effort).toBe("medium")
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.tool_choice).toBeUndefined()
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])

    const json = (await response.json()) as AnthropicResponse
    expect(json.model).toBe("gpt-search")
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
    expect(json.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 7,
      server_tool_use: {
        web_search_requests: 1,
      },
    })
  })

  test("propagates provider web_search JSON failures instead of reconstructing success", async () => {
    nextResponsesAsJson = true
    nextResponsesBody = makeResponsesResult({
      error: { message: "provider web_search failed" },
      output: [],
      status: "failed",
    })

    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(500)
    const json = (await response.json()) as { error?: { message?: string } }
    expect(json.error?.message).toContain("provider web_search failed")

    const successRow = getAdminDb()
      .query("SELECT * FROM request_log WHERE http_status = 200 LIMIT 1;")
      .get() as RequestLogRow | null
    expect(successRow).toBeNull()
  })

  test("records top-level provider web_search JSON failures as errors, not success", async () => {
    writeProviderConfig(undefined, {
      messageApiWebSearchModel: "search/gpt-search",
    })
    nextResponsesAsJson = true
    nextResponsesBody = makeResponsesResult({
      error: { message: "provider web_search failed" },
      output: [],
      status: "failed",
    })

    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "claude-sonnet-4.5",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(500)
    const json = (await response.json()) as { error?: { message?: string } }
    expect(json.error?.message).toContain("provider web_search failed")

    const row = getAdminDb()
      .query("SELECT * FROM request_log WHERE client_model = ? LIMIT 1;")
      .get("claude-sonnet-4.5") as RequestLogRow | null
    expect(row?.http_status).toBe(500)
    expect(row?.error_message).toBe("provider web_search failed")
    expect(row?.tokens_input).toBeNull()
  })

  test("runs codex web_search through streaming Responses", async () => {
    writeProviderConfig({
      search: searchProviderConfig(),
      codex: {
        name: "codex",
        type: "openai-responses",
        baseUrl: "https://codex.example/backend-api",
        apiKey: "unused",
        authType: "authorization",
        models: {
          "gpt-5.4": {
            toolContentSupportType: [],
          },
        },
      },
    })

    const app = createApp()
    const response = await app.request("/codex/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-5.4",
        output_config: {
          effort: "max",
        },
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://codex.example/backend-api/codex/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      reasoning?: { effort?: string }
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.reasoning?.effort).toBe("xhigh")

    const upstreamHeaders = new Headers((init as RequestInit).headers)
    expect(upstreamHeaders.get("accept")).toBe("text/event-stream")

    const json = (await response.json()) as AnthropicResponse
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  test("normalizes reasoning for codex Responses provider messages", async () => {
    writeProviderConfig({
      search: searchProviderConfig(),
      codex: {
        name: "codex",
        type: "openai-responses",
        baseUrl: "https://codex.example/backend-api",
        apiKey: "unused",
        authType: "authorization",
        models: {
          "gpt-5.4": {
            toolContentSupportType: [],
          },
        },
      },
    })

    const app = createApp()
    const response = await app.request("/codex/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-5.4",
        output_config: {
          effort: "max",
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://codex.example/backend-api/codex/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      reasoning?: { effort?: string }
    }
    expect(upstreamBody.reasoning?.effort).toBe("xhigh")
  })

  test("passes explicit reasoning for openai-responses provider messages without Copilot metadata", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-search",
        output_config: {
          effort: "max",
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      reasoning?: { effort?: string }
    }
    expect(upstreamBody.reasoning?.effort).toBe("max")
  })

  test("uses provider alias configured reasoning default from original request model", async () => {
    writeTestConfig({
      auth: { apiKeys: [] },
      modelAliases: {
        "fast-search": {
          target: "search/gpt-search",
        },
      },
      modelReasoningEfforts: {
        "fast-search": "max",
      },
      providers: {
        search: searchProviderConfig(),
      },
    })

    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "fast-search",
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
      reasoning?: { effort?: string }
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.reasoning?.effort).toBe("max")
  })

  test("streams synthetic Anthropic events after parsing upstream Responses stream", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        stream: true,
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)

    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)

    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: content_block_start")
    expect(text).toContain("server_tool_use")
    expect(text).toContain("web_search_tool_result")
    expect(text).toContain("Node.js 24 is the latest LTS.")
    expect(text).toContain("event: message_stop")
  })

  test("strips Anthropic web_search when mixed with normal tools", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-search",
        tools: [
          webSearchTool,
          {
            name: "get_weather",
            input_schema: { type: "object" },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ])
  })

  test("strips Anthropic web_search before OpenAI-compatible translation", async () => {
    writeProviderConfig({
      search: {
        ...searchProviderConfig(),
        type: "openai-compatible",
        baseUrl: "https://provider.example/compatible-mode",
        models: {
          "qwen-plus": {
            toolContentSupportType: [],
          },
        },
      },
    })

    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://provider.example/compatible-mode/v1/chat/completions",
    )

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.tools).toEqual([])
  })

  test("keeps explicit top-level provider aliases ahead of the global web_search fallback", async () => {
    writeProviderConfig(
      {
        dash: dashProviderConfig(),
        search: searchProviderConfig(),
      },
      {
        messageApiWebSearchModel: "search/gpt-search",
      },
    )

    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "dash/qwen-plus",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://dash.example/compatible-mode/v1/chat/completions")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model?: string
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("qwen-plus")
    expect(upstreamBody.tools).toEqual([])
  })

  test("does not treat copilot/model web_search fallback values as provider aliases", async () => {
    writeProviderConfig(undefined, {
      messageApiWebSearchModel: "copilot/gpt-5.4",
    })

    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "claude-sonnet-4.5",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.githubcopilot.com/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model?: string
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("copilot/gpt-5.4")
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])
  })

  test("does not route missing provider/model web_search fallback values through provider aliases", async () => {
    writeProviderConfig(undefined, {
      messageApiWebSearchModel: "missing/gpt-search",
    })

    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "claude-sonnet-4.5",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.githubcopilot.com/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model?: string
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("missing/gpt-search")
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])
  })

  test("collects a Codex stream into JSON when stream is omitted", async () => {
    configureCodexProvider()
    nextResponsesBody = makePlainResponsesResult()
    responsesStreamFactory = makeCollectedResponsesStreamResponse

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")

    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect(new Headers((init as RequestInit).headers).get("accept")).toBe(
      "text/event-stream",
    )

    const json = (await response.json()) as AnthropicResponse
    expect(json.content).toEqual([{ type: "text", text: "Hello from Codex." }])
    expect(json.stop_reason).toBe("end_turn")
    expect(json.usage).toMatchObject({ input_tokens: 12, output_tokens: 7 })
  })

  test("collects a Codex stream into JSON when stream is false", async () => {
    configureCodexProvider()
    nextResponsesBody = makePlainResponsesResult()
    responsesStreamFactory = makeCollectedResponsesStreamResponse

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload({ stream: false })),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect((await response.json()) as AnthropicResponse).toMatchObject({
      content: [{ type: "text", text: "Hello from Codex." }],
      stop_reason: "end_turn",
    })
  })

  test("collects a non-stream Codex tool call into Anthropic JSON", async () => {
    configureCodexProvider()
    nextResponsesBody = makeResponsesResult({
      id: "resp_provider_tool_call",
      model: "gpt-5.4",
      output: [
        {
          id: "fc-provider-weather",
          type: "function_call",
          call_id: "call-provider-weather",
          name: "get_weather",
          arguments: '{"city":"Shanghai"}',
          status: "completed",
        },
      ],
      output_text: "",
    })
    responsesStreamFactory = makeCollectedResponsesStreamResponse

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          tools: [
            {
              name: "get_weather",
              description: "Get the current weather",
              input_schema: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as AnthropicResponse
    expect(json.content).toEqual([
      {
        type: "tool_use",
        id: "call-provider-weather",
        name: "get_weather",
        input: { city: "Shanghai" },
      },
    ])
    expect(json.stop_reason).toBe("tool_use")
  })

  test("forces streaming for a Codex follow-up containing tool_result", async () => {
    configureCodexProvider()
    nextResponsesBody = makePlainResponsesResult()
    responsesStreamFactory = makeCollectedResponsesStreamResponse

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          messages: [
            { role: "user", content: "What is the weather?" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-provider-weather",
                  name: "get_weather",
                  input: { city: "Shanghai" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call-provider-weather",
                  content: "Sunny, 30C",
                },
              ],
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      input?: Array<Record<string, unknown>>
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-provider-weather",
      output: "Sunny, 30C",
      status: "completed",
    })
  })

  test("keeps requested Codex streaming as Anthropic SSE", async () => {
    configureCodexProvider()
    nextResponsesBody = makePlainResponsesResult()
    responsesStreamFactory = makeCollectedResponsesStreamResponse

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload({ stream: true })),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const body = await response.text()
    expect(body).toContain("event: message_start")
    expect(body).toContain("Hello from Codex.")
    expect(body).toContain("event: message_stop")
  })

  test("fails non-stream Codex requests when the upstream stream errors", async () => {
    configureCodexProvider()
    responsesStreamFactory = () =>
      new Response(
        `data: ${JSON.stringify({
          code: "upstream_error",
          message: "Codex stream failed",
          param: null,
          sequence_number: 1,
          type: "error",
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('"type":"message"')
  })

  test("fails non-stream Codex requests when a terminal response reports failure", async () => {
    configureCodexProvider()
    const failedResponse = makePlainResponsesResult()
    responsesStreamFactory = () =>
      new Response(
        `data: ${JSON.stringify({
          response: {
            ...failedResponse,
            error: {
              code: "upstream_error",
              message: "Codex response failed",
            },
            output: [],
            output_text: "",
            status: "failed",
          },
          sequence_number: 1,
          type: "response.failed",
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toContain("Codex response failed")
    expect(body).not.toContain('"type":"message"')
  })

  test("fails non-stream Codex requests without a terminal event", async () => {
    configureCodexProvider()
    responsesStreamFactory = () =>
      new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('"type":"message"')
  })
})
