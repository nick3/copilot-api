import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

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
import { getSmallModel, mergeConfigWithDefaults } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { closeUsageStore, getTokenUsageEventsPage } from "~/lib/token-usage"
import { getUUID } from "~/lib/utils"
import { messageRoutes } from "~/routes/messages/route"

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

type FetchOptions = {
  body?: unknown
}

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
const originalFetch = fetchHolder.fetch
const originalSelect =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)
const originalMarkFailed =
  accountsManager.markAccountFailed.bind(accountsManager)
let dbPathBeforeTest: string | undefined
let configBeforeTest: string | null | undefined

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

function buildModel(
  id: string,
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
      },
      object: "capabilities",
      supports: {
        adaptive_thinking: true,
        streaming: true,
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
    selectedModel: buildModel(modelId, reasoningEffort),
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

async function readSingleTokenUsageEvent() {
  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "day",
  })
  expect(usageEvents.items).toHaveLength(1)
  return usageEvents.items[0]
}

beforeEach(async () => {
  dbPathBeforeTest = process.env[DB_PATH_ENV]
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  configBeforeTest = await readConfigText()

  state.manualApprove = false
  state.verbose = false

  getAdminDb().run("DELETE FROM session_affinity;")

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/v1/messages", "messages-model"))
  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}
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

  if (configBeforeTest !== undefined) {
    await restoreConfigText(configBeforeTest)
    configBeforeTest = undefined
  }
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

  test("Messages to native Messages injects request default effort when omitted", async () => {
    await writeConfig({
      modelReasoningEfforts: {
        "original-model": "max",
        "messages-model": "low",
      },
    })

    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/v1/messages", "messages-model", [
      "low",
      "medium",
      "high",
    ])
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
        body: JSON.stringify(createPayload()),
      }),
    )

    expect(response.status).toBe(200)
    expect((upstreamBody?.output_config as { effort?: string }).effort).toBe(
      "high",
    )
  })

  test("records Copilot AIU from non-streaming Messages API responses", async () => {
    const selection = buildSelection("/v1/messages", "messages-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...buildAnthropicResponse("messages-model", "messages"),
            copilot_usage: {
              total_nano_aiu: 1_000_000_000,
            },
            usage: {
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 30,
              input_tokens: 12,
              output_tokens: 8,
            },
          }),
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
        body: JSON.stringify(createPayload()),
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
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 30,
      cost: {
        amount: 0.01,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 10_000_000,
      },
      endpoint: "messages",
      input_tokens: 12,
      model: "messages-model",
      output_tokens: 8,
      source: "copilot",
      total_nano_aiu: 1_000_000_000,
      total_tokens: 250,
    })
  })

  test("records Copilot AIU from streaming Messages API events", async () => {
    const selection = buildSelection("/v1/messages", "messages-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          [
            "event: message_start",
            `data: ${JSON.stringify({
              message: {
                ...buildAnthropicResponse("messages-model", ""),
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 3,
                  output_tokens: 0,
                },
              },
              type: "message_start",
            })}`,
            "",
            "event: message_delta",
            `data: ${JSON.stringify({
              copilot_usage: {
                total_nano_aiu: 4_119_900_000,
              },
              delta: {
                stop_reason: "end_turn",
                stop_sequence: null,
              },
              type: "message_delta",
              usage: {
                cache_creation_input_tokens: 10_612,
                cache_read_input_tokens: 0,
                output_tokens: 93,
              },
            })}`,
            "",
            "event: message_stop",
            `data: ${JSON.stringify({ type: "message_stop" })}`,
            "",
          ].join("\n"),
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

    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "day",
    })

    expect(response.status).toBe(200)
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      cache_creation_input_tokens: 10_612,
      cache_read_input_tokens: 0,
      cost: {
        amount: 0.041199,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 41_199_000,
      },
      endpoint: "messages",
      input_tokens: 3,
      model: "messages-model",
      output_tokens: 93,
      source: "copilot",
      total_nano_aiu: 4_119_900_000,
      total_tokens: 10_708,
    })
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

  test("Messages to Responses preserves explicit effort as normalized intent", async () => {
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/responses", "responses-model", [
      "low",
      "high",
    ])
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
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
        body: JSON.stringify(
          createPayload({
            output_config: {
              effort: "medium",
            },
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe("low")
  })

  test("Messages to Responses uses request model default before modelMappings", async () => {
    await writeConfig({
      modelMappings: {
        "messages-requested": "mapped-model",
      },
      modelReasoningEfforts: {
        "messages-requested": "max",
        "mapped-model": "low",
      },
    })

    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/responses", "mapped-model", [
      "low",
      "medium",
      "high",
    ])
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("mapped-model", "responses")),
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
        body: JSON.stringify(createPayload({ model: "messages-requested" })),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.model).toBe("mapped-model")
    expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe("high")
  })

  test("records Copilot AIU when Messages routes to non-streaming Responses", async () => {
    const selection = buildSelection("/responses", "responses-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...buildResponsesResult("responses-model", "responses"),
            copilot_usage: {
              total_nano_aiu: 1_500_000_000,
            },
            usage: {
              input_tokens: 9,
              input_tokens_details: {
                cached_tokens: 2,
              },
              output_tokens: 3,
              total_tokens: 12,
            },
          }),
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
        body: JSON.stringify(createPayload()),
      }),
    )
    await response.text()

    expect(response.status).toBe(200)
    expect(await readSingleTokenUsageEvent()).toMatchObject({
      cache_read_input_tokens: 2,
      cost: {
        amount: 0.015,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 15_000_000,
      },
      endpoint: "responses",
      input_tokens: 7,
      model: "responses-model",
      output_tokens: 3,
      source: "copilot",
      total_nano_aiu: 1_500_000_000,
      total_tokens: 12,
    })
  })

  test("records Copilot AIU when Messages routes to streaming Responses", async () => {
    const selection = buildSelection("/responses", "responses-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          [
            "event: response.completed",
            `data: ${JSON.stringify({
              copilot_usage: {
                total_nano_aiu: 2_250_000_000,
              },
              response: {
                ...buildResponsesResult("responses-model", "responses"),
                usage: {
                  input_tokens: 11,
                  input_tokens_details: {
                    cached_tokens: 4,
                  },
                  output_tokens: 5,
                  total_tokens: 16,
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

    expect(response.status).toBe(200)
    expect(await readSingleTokenUsageEvent()).toMatchObject({
      cache_read_input_tokens: 4,
      cost: {
        amount: 0.0225,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 22_500_000,
      },
      endpoint: "responses",
      input_tokens: 7,
      model: "responses-model",
      output_tokens: 5,
      source: "copilot",
      total_nano_aiu: 2_250_000_000,
      total_tokens: 16,
    })
  })

  test("records Copilot AIU when Messages web search routes through Responses", async () => {
    const selection = buildSelection("/responses", "search-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    let upstreamBody: Record<string, unknown> | undefined
    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...buildResponsesResult("search-model", "search result"),
            copilot_usage: {
              total_nano_aiu: 1_750_000_000,
            },
            usage: {
              input_tokens: 13,
              input_tokens_details: {
                cached_tokens: 6,
              },
              output_tokens: 4,
              total_tokens: 17,
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

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            tools: [
              { type: "web_search_20250305", name: "web_search" },
            ] as never,
          }),
        ),
      }),
    )
    await response.text()

    expect(response.status).toBe(200)
    expect(upstreamBody?.model).toBe("search-model")
    expect(await readSingleTokenUsageEvent()).toMatchObject({
      cache_read_input_tokens: 6,
      cost: {
        amount: 0.0175,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 17_500_000,
      },
      endpoint: "responses",
      input_tokens: 7,
      model: "search-model",
      output_tokens: 4,
      source: "copilot",
      total_nano_aiu: 1_750_000_000,
      total_tokens: 17,
    })
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

  test("Messages to Chat Completions writes normalized reasoning_effort", async () => {
    let upstreamBody: Record<string, unknown> | undefined

    const selection = buildSelection("/chat/completions", "chat-model", [
      "low",
      "high",
    ])
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock((_url: string, opts?: FetchOptions) => {
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
        body: JSON.stringify(
          createPayload({
            output_config: {
              effort: "medium",
            },
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamBody?.reasoning_effort).toBe("low")
  })

  test("records Copilot AIU when Messages routes to non-streaming Chat Completions", async () => {
    const selection = buildSelection("/chat/completions", "chat-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...buildChatCompletionResponse("chat-model", "chat"),
            copilot_usage: {
              total_nano_aiu: 3_500_000_000,
            },
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
              prompt_tokens_details: {
                cached_tokens: 5,
              },
            },
          }),
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
        body: JSON.stringify(createPayload()),
      }),
    )
    await response.text()

    expect(response.status).toBe(200)
    expect(await readSingleTokenUsageEvent()).toMatchObject({
      cache_read_input_tokens: 5,
      cost: {
        amount: 0.035,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 35_000_000,
      },
      endpoint: "chat_completions",
      input_tokens: 7,
      model: "chat-model",
      output_tokens: 4,
      source: "copilot",
      total_nano_aiu: 3_500_000_000,
      total_tokens: 16,
    })
  })

  test("records Copilot AIU when Messages routes to streaming Chat Completions", async () => {
    const selection = buildSelection("/chat/completions", "chat-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          [
            "data: "
              + JSON.stringify({
                id: "chatcmpl_1",
                object: "chat.completion.chunk",
                created: 0,
                model: "chat-model",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "chat" },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
                usage: {
                  prompt_tokens: 15,
                  completion_tokens: 6,
                  total_tokens: 21,
                  prompt_tokens_details: {
                    cached_tokens: 8,
                  },
                },
              }),
            "",
            "data: "
              + JSON.stringify({
                id: "chatcmpl_1",
                object: "chat.completion.chunk",
                created: 0,
                model: "chat-model",
                choices: [],
                copilot_usage: {
                  total_nano_aiu: 4_000_000_000,
                },
              }),
            "",
            "data: "
              + JSON.stringify({
                id: "chatcmpl_1",
                object: "chat.completion.chunk",
                created: 0,
                model: "chat-model",
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                    logprobs: null,
                  },
                ],
              }),
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
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

    expect(response.status).toBe(200)
    expect(await readSingleTokenUsageEvent()).toMatchObject({
      cache_read_input_tokens: 8,
      cost: {
        amount: 0.04,
        currency: "USD",
        source: "copilot_aiu",
        total_cost_nanos: 40_000_000,
      },
      endpoint: "chat_completions",
      input_tokens: 7,
      model: "chat-model",
      output_tokens: 6,
      source: "copilot",
      total_nano_aiu: 4_000_000_000,
      total_tokens: 21,
    })
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
