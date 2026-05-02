import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AccountRuntime } from "~/lib/types/account"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { getAdminDb } from "~/lib/admin-db"
import { state } from "~/lib/state"
import { buildResponsesItemOwnershipKey } from "~/routes/messages/responses-item-ownership"
import { messageRoutes } from "~/routes/messages/route"

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

function buildSelection(endpoint: string, modelId: string) {
  return {
    ok: true as const,
    account: buildAccount(),
    selectedModel: buildModel(modelId),
    endpoint,
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    confirmOwnership: mock(() => {}),
    affinityHit: false,
    selectionReason: "affinity_miss" as const,
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

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false

  getAdminDb().run("DELETE FROM request_log;")
  getAdminDb().run("DELETE FROM session_affinity;")

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/responses", "responses-model"))
  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}
})

afterEach(() => {
  fetchHolder.fetch = originalFetch
  accountsManager.selectAccountForRequest = originalSelect
  accountsManager.finalizeQuota = originalFinalize
  accountsManager.markAccountFailed = originalMarkFailed
})

describe("messages handler Responses item ownership", () => {
  test("passes owner keys from thinking signatures into account selection", async () => {
    let selectionOwnerKeys: ReadonlyArray<string> | undefined

    const selection = buildSelection("/responses", "responses-model")
    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionOwnerKeys = options?.responsesItemOwnershipKeys
      return Promise.resolve(selection)
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-model", "responses")),
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
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: "Thinking...",
                    signature: "enc-owner@rs_owner",
                  },
                ],
              },
              { role: "user", content: "continue" },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionOwnerKeys).toEqual([
      buildResponsesItemOwnershipKey("id", "rs_owner"),
      buildResponsesItemOwnershipKey("encrypted_content", "enc-owner"),
    ])
    expect(selectionOwnerKeys?.join("\n")).not.toContain("enc-owner")
  })

  test("records owner keys from successful non-streaming Responses output", async () => {
    const selection = buildSelection("/responses", "responses-model")
    accountsManager.selectAccountForRequest = () => Promise.resolve(selection)

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...buildResponsesResult("responses-model", "responses"),
            output: [
              {
                id: "rs_recorded",
                type: "reasoning",
                summary: [],
                encrypted_content: "enc-recorded",
                status: "completed",
              },
              {
                id: "out_1",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "responses",
                    annotations: [],
                  },
                ],
              },
            ],
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
        body: JSON.stringify(
          createPayload({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: "Thinking...",
                    signature: "enc-lookup@rs_lookup",
                  },
                ],
              },
              { role: "user", content: "continue" },
            ],
          }),
        ),
      }),
    )

    const lookupIdKey = buildResponsesItemOwnershipKey("id", "rs_lookup")
    const lookupEncryptedKey = buildResponsesItemOwnershipKey(
      "encrypted_content",
      "enc-lookup",
    )
    const idKey = buildResponsesItemOwnershipKey("id", "rs_recorded")
    const encryptedKey = buildResponsesItemOwnershipKey(
      "encrypted_content",
      "enc-recorded",
    )
    const rows = getAdminDb()
      .query(
        `SELECT cache_key, account_id FROM session_affinity
         WHERE cache_key IN (?, ?)
         ORDER BY cache_key;`,
      )
      .all(idKey, encryptedKey) as Array<{
      cache_key: string
      account_id: string
    }>

    const requestLog = getAdminDb()
      .query(
        `SELECT
           responses_item_owner_lookup_keys_json,
           responses_item_owner_recorded_keys_json
         FROM request_log
         ORDER BY id DESC
         LIMIT 1;`,
      )
      .get() as {
      responses_item_owner_lookup_keys_json: string | null
      responses_item_owner_recorded_keys_json: string | null
    } | null

    expect(response.status).toBe(200)
    expect(rows).toEqual([
      { cache_key: encryptedKey, account_id: "octocat" },
      { cache_key: idKey, account_id: "octocat" },
    ])
    expect(requestLog?.responses_item_owner_lookup_keys_json).toBe(
      JSON.stringify([lookupIdKey, lookupEncryptedKey]),
    )
    expect(requestLog?.responses_item_owner_recorded_keys_json).toBe(
      JSON.stringify([idKey, encryptedKey]),
    )
  })
})
