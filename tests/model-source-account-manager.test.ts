import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { findEndpointModel } from "~/lib/models"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import { modelRoutes } from "~/routes/models/route"
import { handleProviderCountTokens } from "~/routes/provider/messages/count-tokens-handler"

type ModelsResponse = { data: Array<Model>; object: string }

const buildModel = (id: string, overrides?: Partial<Model>): Model => ({
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
    },
    object: "capabilities",
    supports: {
      max_thinking_budget: 4096,
      min_thinking_budget: 1024,
    },
    tokenizer: "o200k_base",
    type: "chat",
  },
  ...overrides,
})

const originalGetFirstAccountModels =
  accountsManager.getFirstAccountModels.bind(accountsManager)
const legacyState = state as unknown as Record<string, unknown>

const clearLegacyModels = () => {
  Reflect.deleteProperty(legacyState, "models")
}

const withMockedModels = async (
  models: Array<Model>,
  run: () => Promise<void> | void,
) => {
  accountsManager.getFirstAccountModels = () =>
    ({
      data: models,
      object: "list",
    }) as ModelsResponse
  clearLegacyModels()
  await run()
}

afterEach(() => {
  accountsManager.getFirstAccountModels = originalGetFirstAccountModels
  clearLegacyModels()
})

describe("account-managed model sources", () => {
  test("GET /v1/models returns account-managed models when legacy state cache is absent", async () => {
    await withMockedModels(
      [buildModel("copilot-test-route-model")],
      async () => {
        const res = await modelRoutes.fetch(new Request("http://local/"))

        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          data: Array<{ id: string }>
        }

        expect(body.data.map((model) => model.id)).toContain(
          "copilot-test-route-model",
        )
      },
    )
  })

  test("findEndpointModel resolves normalized Claude ids from account-managed models", async () => {
    await withMockedModels([buildModel("claude-sonnet-4.5")], () => {
      expect(findEndpointModel("claude-sonnet-4-5-20250514")?.id).toBe(
        "claude-sonnet-4.5",
      )
    })
  })

  test("translateToOpenAI derives thinking budget from account-managed models", async () => {
    const model = buildModel("claude-sonnet-4.5")

    await withMockedModels([model], () => {
      const payload: AnthropicMessagesPayload = {
        model: model.id,
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 512,
        thinking: {
          type: "enabled",
          budget_tokens: 2048,
        },
      }

      const openAIPayload = translateToOpenAI(payload)

      expect(openAIPayload.thinking_budget).toBe(2048)
    })
  })

  test("provider count_tokens uses tokenizer from account-managed models", async () => {
    const providerModel = buildModel("provider-test-model", {
      capabilities: {
        family: "test",
        limits: {},
        object: "capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    })
    const content = "你好🙂你好🙂你好🙂"
    const openAIPayload: ChatCompletionsPayload = {
      model: providerModel.id,
      messages: [{ role: "user", content }],
    }
    const expected = await getTokenCount(openAIPayload, providerModel)

    await withMockedModels([providerModel], async () => {
      const app = new Hono()
      app.post(
        "/providers/:provider/messages/count_tokens",
        handleProviderCountTokens,
      )

      const res = await app.request("/providers/test/messages/count_tokens", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: providerModel.id,
          messages: [{ role: "user", content }],
          max_tokens: 1,
        } satisfies AnthropicMessagesPayload),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        input_tokens: expected.input + expected.output,
      })
    })
  })
})
