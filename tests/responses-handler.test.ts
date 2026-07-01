import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import "./shared-admin-db-test-home"

import type { UsageTokens } from "~/lib/token-usage"
import type { AccountRuntime } from "~/lib/types/account"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

const actualTokenUsageModule = await import("~/lib/token-usage")
const { closeUsageStore, getTokenUsageEventsPage } = actualTokenUsageModule
type ProviderUsageRecorderOptions = Parameters<
  (typeof actualTokenUsageModule)["createProviderTokenUsageRecorder"]
>[0]
const providerUsageRecords: Array<{
  options: ProviderUsageRecorderOptions
  usage: UsageTokens
}> = []

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder:
    (options: ProviderUsageRecorderOptions) => (usage: UsageTokens) => {
      providerUsageRecords.push({ options, usage })
    },
}))

const [
  { accountsManager },
  { getAdminDb },
  { state },
  { mergeConfigWithDefaults, setModelMappings, setProviderConfig },
  { PATHS },
  { responsesRoutes },
  { INTERNAL_CHAT_METADATA_PASSTHROUGH_KEY, responsesUtilsDependencies },
] = await Promise.all([
  import("~/lib/accounts-manager"),
  import("~/lib/admin-db"),
  import("~/lib/state"),
  import("~/lib/config"),
  import("~/lib/paths"),
  import("~/routes/responses/route"),
  import("~/routes/responses/utils"),
])

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

type FetchOptions = {
  body?: unknown
  headers?: Record<string, string>
}

const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
const originalFetch = fetchHolder.fetch
const originalSelect =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)
const originalMarkFailed =
  accountsManager.markAccountFailed.bind(accountsManager)
const originalContextManagementEnabled =
  responsesUtilsDependencies.isResponsesApiContextManagementEnabled
const originalModelCompactThreshold =
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
let configBeforeTest: string | null | undefined
let dbPathBeforeTest: string | undefined

const readConfigText = async (): Promise<string | null> =>
  await fs.readFile(PATHS.CONFIG_PATH, "utf8").catch(() => null)

const restoreConfigText = async (configText: string | null): Promise<void> => {
  if (configText === null) {
    await fs.rm(PATHS.CONFIG_PATH, { force: true })
  } else {
    await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
    await fs.writeFile(PATHS.CONFIG_PATH, configText, "utf8")
  }
  mergeConfigWithDefaults()
}

const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
  await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
  await fs.writeFile(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()
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

function buildModel(
  id: string,
  maxPromptImageSize?: number,
  reasoningEffort: Array<string> = ["low", "medium", "high", "xhigh"],
): Model {
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
        ...(maxPromptImageSize !== undefined ?
          { vision: { max_prompt_image_size: maxPromptImageSize } }
        : {}),
      },
      object: "capabilities",
      supports: {
        adaptive_thinking: true,
        streaming: true,
        vision: maxPromptImageSize !== undefined ? true : undefined,
        reasoning_effort: reasoningEffort,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function buildSelection(
  endpoint: string,
  modelId: string,
  reasoningEffort?: Array<string>,
): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel(modelId, undefined, reasoningEffort),
    endpoint,
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    affinityHit: false,
    affinityCacheKey: "test-cache-key",
    selectionReason: "affinity_miss",
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

beforeEach(async () => {
  dbPathBeforeTest = process.env[DB_PATH_ENV]
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  configBeforeTest = await readConfigText()

  providerUsageRecords.length = 0

  state.manualApprove = false
  state.verbose = false

  getAdminDb().run("DELETE FROM request_log;")
  getAdminDb().run("DELETE FROM session_affinity;")

  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}

  setModelMappings({})
})

afterEach(async () => {
  fetchHolder.fetch = originalFetch
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

  responsesUtilsDependencies.isResponsesApiContextManagementEnabled =
    originalContextManagementEnabled
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold =
    originalModelCompactThreshold

  if (configBeforeTest !== undefined) {
    await restoreConfigText(configBeforeTest)
    configBeforeTest = undefined
  }
})

describe("responses handler model mapping", () => {
  test("applies modelMappings to client model before account selection", async () => {
    setModelMappings({ "gpt-original": "gpt-mapped" })

    let selectionCandidates:
      | ReadonlyArray<{ modelId: string; endpoint: string }>
      | undefined
    accountsManager.selectAccountForRequest = (candidates) => {
      selectionCandidates = candidates
      return Promise.resolve(buildSelection("/responses", "gpt-mapped"))
    }

    const fetchMock = mock((_url: string, _opts?: FetchOptions) => {
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-mapped", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-original",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionCandidates?.[0]?.modelId).toBe("gpt-mapped")
  })

  test("leaves model unchanged when no mapping is configured", async () => {
    let selectionCandidates:
      | ReadonlyArray<{ modelId: string; endpoint: string }>
      | undefined
    accountsManager.selectAccountForRequest = (candidates) => {
      selectionCandidates = candidates
      return Promise.resolve(buildSelection("/responses", "gpt-original"))
    }

    const fetchMock = mock((_url: string, _opts?: FetchOptions) => {
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("gpt-original", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-original",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionCandidates?.[0]?.modelId).toBe("gpt-original")
  })
})

describe("responses handler reasoning effort normalization", () => {
  test("normalizes explicit Responses reasoning effort to selected model support", async () => {
    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "gpt-test", ["low", "high"]))

    let upstreamBody: Record<string, unknown> | undefined
    fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-test", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          input: "hello",
          reasoning: { effort: "medium" },
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe("low")
  })

  test("injects configured fallback effort for supported Responses models", async () => {
    await writeConfig({
      modelReasoningEfforts: {
        "gpt-test": "high",
      },
    })

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(
        buildSelection("/responses", "gpt-test", ["low", "medium"]),
      )

    let upstreamBody: Record<string, unknown> | undefined
    fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-test", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe(
      "medium",
    )
  })

  test("does not inject configured fallback when Responses reasoning effort is explicit null", async () => {
    await writeConfig({
      modelReasoningEfforts: {
        "gpt-test": "high",
      },
    })

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(
        buildSelection("/responses", "gpt-test", ["low", "medium", "high"]),
      )

    let upstreamBody: Record<string, unknown> | undefined
    fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-test", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          input: "hello",
          reasoning: { effort: null, summary: "auto" },
        }),
      }),
    )

    const reasoning = upstreamBody?.reasoning as
      | { effort?: string; summary?: string }
      | undefined

    expect(response.status).toBe(200)
    expect(reasoning?.summary).toBe("auto")
    expect(Object.hasOwn(reasoning ?? {}, "effort")).toBe(false)
  })

  test("preserves explicit null Responses reasoning without injecting fallback", async () => {
    await writeConfig({
      modelReasoningEfforts: {
        "gpt-test": "high",
      },
    })

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(
        buildSelection("/responses", "gpt-test", ["low", "medium", "high"]),
      )

    let upstreamBody: Record<string, unknown> | undefined
    fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-test", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          input: "hello",
          reasoning: null,
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.reasoning).toBeNull()
  })

  test("uses requested model configured fallback before modelMappings", async () => {
    await writeConfig({
      modelMappings: {
        "responses-requested": "responses-mapped",
      },
      modelReasoningEfforts: {
        "responses-requested": "max",
        "responses-mapped": "low",
      },
    })

    let selectionCandidates:
      | ReadonlyArray<{ modelId: string; endpoint: string }>
      | undefined
    accountsManager.selectAccountForRequest = (candidates) => {
      selectionCandidates = candidates
      return Promise.resolve(
        buildSelection("/responses", "responses-mapped", [
          "low",
          "medium",
          "high",
        ]),
      )
    }

    let upstreamBody: Record<string, unknown> | undefined
    fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-mapped", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    }) as unknown as typeof fetch

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "responses-requested",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionCandidates?.[0]?.modelId).toBe("responses-mapped")
    expect(upstreamBody?.model).toBe("responses-mapped")
    expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe("high")
  })

  test("uses selected target model configured fallback when request model has none", async () => {
    await writeConfig({
      modelReasoningEfforts: {},
      modelMappings: {},
    })

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(
        buildSelection("/responses", "gpt-5-mini", ["low", "medium", "high"]),
      )

    let upstreamBody: Record<string, unknown> | undefined
    fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-5-mini", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "unconfigured-responses-request",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.model).toBe("gpt-5-mini")
    expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe("low")
  })

  test("omits reasoning effort but preserves other reasoning fields without configured default", async () => {
    await writeConfig({
      modelReasoningEfforts: {},
      modelMappings: {},
    })

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(
        buildSelection("/responses", "unconfigured-responses", [
          "low",
          "medium",
          "high",
        ]),
      )

    let upstreamBody: Record<string, unknown> | undefined
    fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("unconfigured-responses", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    }) as unknown as typeof fetch

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "unconfigured-responses",
          input: "hello",
          reasoning: { summary: "auto" },
        }),
      }),
    )

    const reasoning = upstreamBody?.reasoning as
      | { effort?: string; summary?: string }
      | undefined

    expect(response.status).toBe(200)
    expect(reasoning?.summary).toBe("auto")
    expect(Object.hasOwn(reasoning ?? {}, "effort")).toBe(false)
  })

  test("removes Responses reasoning object when effort cleanup leaves it empty", async () => {
    await writeConfig({
      modelReasoningEfforts: {},
      modelMappings: {},
    })

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(
        buildSelection("/responses", "unconfigured-responses", [
          "low",
          "medium",
          "high",
        ]),
      )

    let upstreamBody: Record<string, unknown> | undefined
    fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("unconfigured-responses", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    }) as unknown as typeof fetch

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "unconfigured-responses",
          input: "hello",
          reasoning: { effort: null },
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(Object.hasOwn(upstreamBody ?? {}, "reasoning")).toBe(false)
  })
})

describe("responses handler Copilot AIU token usage", () => {
  test("records Copilot AIU from non-streaming native Responses results", async () => {
    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "gpt-test"))

    const fetchMock = mock((_url: string, _opts?: FetchOptions) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...buildResponsesResult("gpt-test", "ok"),
            copilot_usage: {
              total_nano_aiu: 1_234_000_000,
            },
            usage: {
              input_tokens: 5,
              input_tokens_details: {
                cached_tokens: 1,
              },
              output_tokens: 2,
              total_tokens: 7,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          input: "hello",
        }),
      }),
    )
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
        amount: 0.01234,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 12_340_000,
      },
      endpoint: "responses",
      input_tokens: 4,
      model: "gpt-test",
      output_tokens: 2,
      source: "copilot",
      total_nano_aiu: 1_234_000_000,
      total_tokens: 7,
    })
  })

  test("records Copilot AIU from streaming native Responses terminal events", async () => {
    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "gpt-test"))

    const fetchMock = mock((_url: string, _opts?: FetchOptions) => {
      return Promise.resolve(
        new Response(
          [
            "event: response.completed",
            `data: ${JSON.stringify({
              copilot_usage: {
                total_nano_aiu: 2_500_000_000,
              },
              response: {
                ...buildResponsesResult("gpt-test", "ok"),
                usage: {
                  input_tokens: 10,
                  input_tokens_details: {
                    cached_tokens: 4,
                  },
                  output_tokens: 3,
                  total_tokens: 13,
                },
              },
              sequence_number: 1,
              type: "response.completed",
            })}`,
            "",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          input: "hello",
          stream: true,
        }),
      }),
    )
    await response.text()

    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "day",
    })

    expect(response.status).toBe(200)
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      cache_read_input_tokens: 4,
      cost: {
        amount: 0.025,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 25_000_000,
      },
      endpoint: "responses",
      input_tokens: 6,
      model: "gpt-test",
      output_tokens: 3,
      source: "copilot",
      total_nano_aiu: 2_500_000_000,
      total_tokens: 13,
    })
  })
})

describe("responses handler provider alias routing", () => {
  test("routes provider-prefixed models to provider responses handler", async () => {
    setProviderConfig("acme", {
      type: "openai-responses",
      enabled: true,
      baseUrl: "https://acme.example.com",
      apiKey: "acme-key",
      authType: "authorization",
    })

    const selectSpy = mock(() =>
      Promise.resolve(buildSelection("/responses", "any")),
    )
    accountsManager.selectAccountForRequest = selectSpy

    let providerForwardedUrl: string | undefined
    const fetchMock = mock((url: string, _opts?: FetchOptions) => {
      providerForwardedUrl = url
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("gpt-acme", "from acme")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "acme/gpt-acme",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectSpy).not.toHaveBeenCalled()
    expect(providerForwardedUrl).toContain("acme.example.com")

    expect(providerUsageRecords).toHaveLength(1)
    expect(providerUsageRecords[0]?.options).toMatchObject({
      endpoint: "responses",
      model: "gpt-acme",
      providerName: "acme",
    })
    expect(providerUsageRecords[0]?.usage).toMatchObject({
      cache_read_input_tokens: 0,
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    })
  })

  test("strips Codex internal chat metadata before forwarding provider aliases", async () => {
    setProviderConfig("acme", {
      type: "openai-responses",
      enabled: true,
      baseUrl: "https://acme.example.com",
      apiKey: "acme-key",
      authType: "authorization",
    })

    let providerForwardedPayload: ResponsesPayload | undefined
    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      providerForwardedPayload = JSON.parse(
        options?.body as string,
      ) as ResponsesPayload
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("gpt-acme", "from acme")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "acme/gpt-acme",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "hello" }],
              [INTERNAL_CHAT_METADATA_PASSTHROUGH_KEY]: {
                turn_id: "turn-provider",
              },
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(providerForwardedPayload?.model).toBe("gpt-acme")

    const forwardedInput = providerForwardedPayload?.input as Array<
      Record<string, unknown>
    >
    expect(INTERNAL_CHAT_METADATA_PASSTHROUGH_KEY in forwardedInput[0]).toBe(
      false,
    )
    expect(forwardedInput[0].content).toEqual([
      { type: "input_text", text: "hello" },
    ])
  })
})

describe("responses handler context management", () => {
  test("uses configured model compact threshold before max token fallback", async () => {
    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "gpt-5.4"))

    let forwardedPayload: ResponsesPayload | undefined
    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      forwardedPayload = JSON.parse(options?.body as string) as ResponsesPayload
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-5.4", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(forwardedPayload?.context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 217600,
      },
    ])
  })

  test("does not add context_management when disabled", async () => {
    responsesUtilsDependencies.isResponsesApiContextManagementEnabled = () =>
      false

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "gpt-5.4"))

    let forwardedPayload: ResponsesPayload | undefined
    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      forwardedPayload = JSON.parse(options?.body as string) as ResponsesPayload
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-5.4", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(forwardedPayload?.context_management).toBeUndefined()
  })

  test("does not add context management when input ends with compaction trigger", async () => {
    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "gpt-5.4"))

    let forwardedPayload: ResponsesPayload | undefined
    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      forwardedPayload = JSON.parse(options?.body as string) as ResponsesPayload
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-5.4", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: [
            {
              content: [
                {
                  text: "Completed the review for the latest two commits.",
                  type: "output_text",
                },
              ],
              phase: "final_answer",
              role: "assistant",
              type: "message",
            },
            {
              type: "compaction_trigger",
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(forwardedPayload?.context_management).toBeUndefined()
  })

  test("preserves request-provided context_management", async () => {
    responsesUtilsDependencies.isResponsesApiContextManagementEnabled = () =>
      true

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "gpt-5.4"))

    let forwardedPayload: ResponsesPayload | undefined
    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      forwardedPayload = JSON.parse(options?.body as string) as ResponsesPayload
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-5.4", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "hello",
          context_management: [
            {
              type: "compaction",
              compact_threshold: 12345,
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(forwardedPayload?.context_management?.[0]?.compact_threshold).toBe(
      12345,
    )
  })
})

describe("responses handler Codex subagent detection", () => {
  test("forces agent initiator and reuses incoming session when Codex headers present", async () => {
    let selectionRequestId: string | undefined
    let upstreamInteractionId: string | undefined
    let upstreamInitiator: string | undefined
    let upstreamInteractionType: string | undefined

    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionRequestId = options?.requestId
      return Promise.resolve(buildSelection("/responses", "responses-model"))
    }

    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      upstreamInteractionId = options?.headers?.["x-interaction-id"]
      upstreamInitiator = options?.headers?.["x-initiator"]
      upstreamInteractionType = options?.headers?.["x-interaction-type"]
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "session-id": "root-session",
          "thread-id": "child-thread",
          "x-codex-parent-thread-id": "parent-thread",
          "x-openai-subagent": "collab_spawn",
        },
        body: JSON.stringify({
          model: "responses-model",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    // sessionId derived from incoming session header (root-session) for upstream interaction-id
    expect(upstreamInitiator).toBe("agent")
    expect(upstreamInteractionType).toBe("conversation-subagent")
    expect(upstreamInteractionId).toBeDefined()
    // requestId fed into account selection should be derived from the incoming session
    expect(selectionRequestId).toBeDefined()
  })

  test("ignores unknown x-openai-subagent values", async () => {
    let upstreamInteractionType: string | undefined

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "responses-model"))

    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      upstreamInteractionType = options?.headers?.["x-interaction-type"]
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "session-id": "root-session",
          "thread-id": "child-thread",
          "x-openai-subagent": "unknown_type",
        },
        body: JSON.stringify({
          model: "responses-model",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamInteractionType).not.toBe("conversation-subagent")
  })

  test("ignores Codex subagent header without thread/session ids", async () => {
    let upstreamInteractionType: string | undefined

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "responses-model"))

    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      upstreamInteractionType = options?.headers?.["x-interaction-type"]
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openai-subagent": "collab_spawn",
        },
        body: JSON.stringify({
          model: "responses-model",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamInteractionType).not.toBe("conversation-subagent")
  })
})

describe("responses handler oversized image sanitization", () => {
  test("replaces oversized images with placeholder before forwarding", async () => {
    const visionModel: Model = buildModel("vision-model", 1024)
    accountsManager.selectAccountForRequest = () =>
      Promise.resolve({
        ...buildSelection("/responses", "vision-model"),
        selectedModel: visionModel,
      })

    let forwardedPayload: ResponsesPayload | undefined
    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      forwardedPayload = JSON.parse(options?.body as string) as ResponsesPayload
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("vision-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const oversizedImageUrl = `data:image/png;base64,${"A".repeat(8192)}`

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "vision-model",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "look" },
                {
                  type: "input_image",
                  detail: "low",
                  image_url: oversizedImageUrl,
                },
              ],
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(forwardedPayload).toBeDefined()
    const forwardedInput = forwardedPayload?.input as Array<{
      content: Array<{ type: string; image_url?: string }>
    }>
    const forwardedImage = forwardedInput[0]?.content?.[1]
    expect(forwardedImage?.type).toBe("input_image")
    expect(forwardedImage?.image_url).not.toBe(oversizedImageUrl)
    expect(
      forwardedImage?.image_url?.startsWith("data:image/png;base64,"),
    ).toBe(true)
  })
})

describe("responses handler Codex internal chat metadata stripping", () => {
  test("strips internal_chat_message_metadata_passthrough from every input item before forwarding upstream", async () => {
    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "gpt-5.5"))

    let forwardedPayload: ResponsesPayload | undefined
    const fetchMock = mock((_url: string, options?: FetchOptions) => {
      forwardedPayload = JSON.parse(options?.body as string) as ResponsesPayload
      return Promise.resolve(
        new Response(JSON.stringify(buildResponsesResult("gpt-5.5", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    // Mirrors a Codex >= v0.142.x turn payload: each input item carries the
    // turn-id passthrough field that GitHub Copilot's upstream rejects.
    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "test message" }],
              internal_chat_message_metadata_passthrough: {
                turn_id: "turn-1",
              },
            },
            {
              type: "function_call",
              call_id: "call-1",
              name: "shell",
              arguments: "{}",
              internal_chat_message_metadata_passthrough: {
                turn_id: "turn-1",
              },
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)

    const forwardedInput = forwardedPayload?.input as Array<
      Record<string, unknown>
    >
    expect(Array.isArray(forwardedInput)).toBe(true)
    for (const item of forwardedInput) {
      expect("internal_chat_message_metadata_passthrough" in item).toBe(false)
    }
    // Real content survives the strip.
    expect(forwardedInput[0].role).toBe("user")
    expect(forwardedInput[1].name).toBe("shell")
  })
})
