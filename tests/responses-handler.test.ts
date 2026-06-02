import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import "./shared-admin-db-test-home"

import type { AccountRuntime } from "~/lib/types/account"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

const [
  { accountsManager },
  { getAdminDb },
  { state },
  { setModelMappings, setProviderConfig },
  { responsesRoutes },
] = await Promise.all([
  import("~/lib/accounts-manager"),
  import("~/lib/admin-db"),
  import("~/lib/state"),
  import("~/lib/config"),
  import("~/routes/responses/route"),
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

function buildModel(id: string, maxPromptImageSize?: number): Model {
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

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false

  getAdminDb().run("DELETE FROM request_log;")
  getAdminDb().run("DELETE FROM session_affinity;")

  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}

  setModelMappings({})
})

afterEach(() => {
  fetchHolder.fetch = originalFetch
  accountsManager.selectAccountForRequest = originalSelect
  accountsManager.finalizeQuota = originalFinalize
  accountsManager.markAccountFailed = originalMarkFailed

  setModelMappings({})
  setProviderConfig("acme", { enabled: false })
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

    setProviderConfig("acme", { enabled: false })
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
