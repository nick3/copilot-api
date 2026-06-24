import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import {
  getLogLevel,
  getMessageApiWebSearchModel,
  mergeConfigWithDefaults,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"

type TestConfig = Record<string, unknown>

const withConfig = async (
  config: TestConfig,
  run: () => Promise<void> | void,
) => {
  const original = await fs
    .readFile(PATHS.CONFIG_PATH, "utf8")
    .catch(() => null)

  await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
  await fs.writeFile(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()

  try {
    await run()
  } finally {
    if (original === null) {
      await fs.rm(PATHS.CONFIG_PATH, { force: true })
    } else {
      await fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    }
    mergeConfigWithDefaults()
  }
}

test("GET /api/admin/config returns default logLevel", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config"),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { logLevel?: string }
    expect(body.logLevel).toBe("info")
  })
})

test("POST /api/admin/config updates logLevel", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const postRes = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ logLevel: "debug" }),
      }),
    )

    expect(postRes.status).toBe(200)

    const postBody = (await postRes.json()) as { logLevel?: string }
    expect(postBody.logLevel).toBe("debug")

    const getRes = await server.fetch(
      new Request("http://localhost/api/admin/config"),
    )

    expect(getRes.status).toBe(200)

    const getBody = (await getRes.json()) as { logLevel?: string }
    expect(getBody.logLevel).toBe("debug")
    expect(getLogLevel()).toBe("debug")
  })
})

test("POST /api/admin/config clears logLevel to default", async () => {
  await withConfig({ logLevel: "debug" }, async () => {
    const { server } = await import("../src/server")

    const postRes = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ logLevel: null }),
      }),
    )

    expect(postRes.status).toBe(200)

    const postBody = (await postRes.json()) as { logLevel?: string }
    expect(postBody.logLevel).toBe("info")

    const getRes = await server.fetch(
      new Request("http://localhost/api/admin/config"),
    )

    expect(getRes.status).toBe(200)

    const getBody = (await getRes.json()) as { logLevel?: string }
    expect(getBody.logLevel).toBe("info")
    expect(getLogLevel()).toBe("info")
  })
})

test("POST /api/admin/config rejects invalid logLevel strings", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ logLevel: "verbose" }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("logLevel must be one of")
  })
})

test("POST /api/admin/config rejects non-string logLevel", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ logLevel: false }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toBe("logLevel must be a string")
  })
})

test("POST /api/admin/config updates useMessagesApi", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useMessagesApi: false }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { useMessagesApi?: boolean }
    expect(body.useMessagesApi).toBe(false)
  })
})

test("POST /api/admin/config updates copilotUseLocalModels", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ copilotUseLocalModels: true }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { copilotUseLocalModels?: boolean }
    expect(body.copilotUseLocalModels).toBe(true)
  })
})

test("POST /api/admin/config updates useResponsesApiWebSearch", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useResponsesApiWebSearch: false }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      useResponsesApiWebSearch?: boolean
    }
    expect(body.useResponsesApiWebSearch).toBe(false)
  })
})

test("POST /api/admin/config updates messageApiWebSearchModel", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ messageApiWebSearchModel: "search/gpt-search" }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      messageApiWebSearchModel?: string
    }
    expect(body.messageApiWebSearchModel).toBe("search/gpt-search")
  })
})

test("POST /api/admin/config clears messageApiWebSearchModel without fallback", async () => {
  await withConfig(
    { messageApiWebSearchModel: "search/gpt-search" },
    async () => {
      const { server } = await import("../src/server")

      const res = await server.fetch(
        new Request("http://localhost/api/admin/config", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ messageApiWebSearchModel: "" }),
        }),
      )

      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        messageApiWebSearchModel?: string
      }
      expect(body.messageApiWebSearchModel).toBeUndefined()
      expect(getMessageApiWebSearchModel()).toBeUndefined()
    },
  )
})

test("getMessageApiWebSearchModel trims configured model names", async () => {
  await withConfig(
    { messageApiWebSearchModel: "  search/gpt-search  " },
    () => {
      expect(getMessageApiWebSearchModel()).toBe("search/gpt-search")
    },
  )
})

test("POST /api/admin/config updates useResponsesApiWebSocket", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useResponsesApiWebSocket: false }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      useResponsesApiWebSocket?: boolean
    }
    expect(body.useResponsesApiWebSocket).toBe(false)
  })
})

test("POST /api/admin/config updates anthropicApiKey", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ anthropicApiKey: "  sk-ant-test  " }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { anthropicApiKey?: string }
    expect(body.anthropicApiKey).toBe("sk-ant-test")
  })
})

test("POST /api/admin/config clears anthropicApiKey", async () => {
  await withConfig({ anthropicApiKey: "sk-ant-test" }, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ anthropicApiKey: "" }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { anthropicApiKey?: string }
    expect(body.anthropicApiKey).toBeUndefined()
  })
})

test("POST /api/admin/config updates responsesApiContextManagementModels", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          responsesApiContextManagementModels: [" gpt-5-mini ", "gpt-5-mini"],
        }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      responsesApiContextManagementModels?: Array<string>
    }
    expect(body.responsesApiContextManagementModels).toEqual(["gpt-5-mini"])
  })
})

test("POST /api/admin/config rejects invalid responsesApiContextManagementModels entries", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          responsesApiContextManagementModels: [""],
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain(
      "responsesApiContextManagementModels[0]",
    )
  })
})

test("POST /api/admin/config updates modelResponsesApiCompactThresholds", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelResponsesApiCompactThresholds: {
            "gpt-5.4": 123456,
            "gpt-5.5": 217600,
          },
        }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      modelResponsesApiCompactThresholds?: Record<string, number>
    }
    expect(body.modelResponsesApiCompactThresholds).toEqual({
      "gpt-5.4": 123456,
      "gpt-5.5": 217600,
    })
  })
})

test("POST /api/admin/config clears modelResponsesApiCompactThresholds", async () => {
  await withConfig(
    {
      modelResponsesApiCompactThresholds: {
        "gpt-5.4": 123456,
      },
    },
    async () => {
      const { server } = await import("../src/server")

      const res = await server.fetch(
        new Request("http://localhost/api/admin/config", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ modelResponsesApiCompactThresholds: null }),
        }),
      )

      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        modelResponsesApiCompactThresholds?: Record<string, number>
      }
      expect(body.modelResponsesApiCompactThresholds).toEqual({
        "gpt-5.4": 217600,
        "gpt-5.5": 217600,
      })
    },
  )
})

test("POST /api/admin/config rejects invalid modelResponsesApiCompactThresholds entries", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelResponsesApiCompactThresholds: {
            "gpt-5.4": -1,
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toBe(
      "modelResponsesApiCompactThresholds.gpt-5.4 must be a positive finite number",
    )
  })
})

test("POST /api/admin/config rejects blocked normalized modelResponsesApiCompactThresholds keys", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelResponsesApiCompactThresholds: {
            " __proto__ ": 123456,
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toBe(
      "modelResponsesApiCompactThresholds.__proto__ is not allowed",
    )
  })
})

test("POST /api/admin/config rejects conflicting normalized modelResponsesApiCompactThresholds entries", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelResponsesApiCompactThresholds: {
            "gpt-5.4": 123456,
            " gpt-5.4 ": 217600,
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain(
      'conflicts with normalized key "gpt-5.4"',
    )
  })
})

test("POST /api/admin/config updates providers", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            custom: {
              type: "openai-compatible",
              enabled: true,
              baseUrl: "https://example.com",
              apiKey: "sk-test",
              authType: "oauth2",
              pricingCurrency: " CNY ",
              adjustInputTokens: true,
              models: {
                "kimi-k2.5": {
                  temperature: 1,
                  topP: 0.95,
                  topK: 40,
                  contextCache: true,
                  supportPdf: true,
                  toolContentSupportType: ["array", "image", "pdf", "image"],
                  extraBody: {
                    metadata: {
                      source: "admin-ui",
                    },
                    thinking_budget: 2048,
                  },
                  pricing: {
                    cachedInput: 0.5,
                    cacheCreationInput: 0.75,
                    explicitCachedInput: 0.25,
                    input: 1,
                    maxInputTokens: 32_000,
                    output: 2,
                    tiers: [
                      {
                        input: 2,
                        maxInputTokens: 200_000,
                        output: 4,
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      providers: {
        custom: {
          type: string
          enabled: boolean
          baseUrl: string
          apiKey: string
          authType: string
          pricingCurrency: string
          adjustInputTokens: boolean
          models: {
            "kimi-k2.5": {
              temperature: number
              topP: number
              topK: number
              contextCache: boolean
              supportPdf: boolean
              toolContentSupportType: Array<string>
              extraBody: {
                metadata: {
                  source: string
                }
                thinking_budget: number
              }
              pricing: {
                cachedInput: number
                cacheCreationInput: number
                explicitCachedInput: number
                input: number
                maxInputTokens: number
                output: number
                tiers: Array<{
                  input: number
                  maxInputTokens: number
                  output: number
                }>
              }
            }
          }
        }
      }
    }

    const provider = body.providers.custom
    const model = provider.models["kimi-k2.5"]

    expect(provider.type).toBe("openai-compatible")
    expect(provider.enabled).toBe(true)
    expect(provider.baseUrl).toBe("https://example.com")
    expect(provider.apiKey).toBe("sk-test")
    expect(provider.authType).toBe("oauth2")
    expect(provider.pricingCurrency).toBe("CNY")
    expect(provider.adjustInputTokens).toBe(true)
    expect(model.temperature).toBe(1)
    expect(model.topP).toBe(0.95)
    expect(model.topK).toBe(40)
    expect(model.contextCache).toBe(true)
    expect(model.supportPdf).toBe(true)
    expect(model.toolContentSupportType).toEqual(["array", "image", "pdf"])
    expect(model.extraBody).toEqual({
      metadata: {
        source: "admin-ui",
      },
      thinking_budget: 2048,
    })
    expect(model.pricing).toEqual({
      cachedInput: 0.5,
      cacheCreationInput: 0.75,
      explicitCachedInput: 0.25,
      input: 1,
      maxInputTokens: 32_000,
      output: 2,
      tiers: [
        {
          input: 2,
          maxInputTokens: 200_000,
          output: 4,
        },
      ],
    })
  })
})

test("POST /api/admin/config accepts supported provider types", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            anthropicProvider: { type: "anthropic" },
            chatProvider: { type: "openai-compatible" },
            responsesProvider: { type: "openai-responses" },
          },
        }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      providers: Record<string, { type?: string }>
    }
    expect(body.providers.anthropicProvider.type).toBe("anthropic")
    expect(body.providers.chatProvider.type).toBe("openai-compatible")
    expect(body.providers.responsesProvider.type).toBe("openai-responses")
  })
})

test("POST /api/admin/config trims and clears provider pricingCurrency", async () => {
  await withConfig(
    {
      providers: {
        custom: {
          pricingCurrency: "USD",
        },
      },
    },
    async () => {
      const { server } = await import("../src/server")

      const updateRes = await server.fetch(
        new Request("http://localhost/api/admin/config", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providers: {
              custom: {
                pricingCurrency: " CNY ",
              },
            },
          }),
        }),
      )

      expect(updateRes.status).toBe(200)
      const updateBody = (await updateRes.json()) as {
        providers: Record<string, { pricingCurrency?: string }>
      }
      expect(updateBody.providers.custom.pricingCurrency).toBe("CNY")

      const clearRes = await server.fetch(
        new Request("http://localhost/api/admin/config", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providers: {
              custom: {
                pricingCurrency: "",
              },
            },
          }),
        }),
      )

      expect(clearRes.status).toBe(200)
      const clearBody = (await clearRes.json()) as {
        providers: Record<string, { pricingCurrency?: string }>
      }
      expect(clearBody.providers.custom.pricingCurrency).toBeUndefined()
    },
  )
})

test("POST /api/admin/config rejects invalid provider pricingCurrency", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            custom: {
              pricingCurrency: 123,
            },
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toBe(
      "providers.custom.pricingCurrency must be a string",
    )
  })
})

test("POST /api/admin/config rejects invalid provider model advanced fields", async () => {
  const cases = [
    {
      config: { extraBody: [] },
      message: "providers.custom.models.model.extraBody must be an object",
    },
    {
      config: { extraBody: Object.fromEntries([["__proto__", true]]) },
      message:
        "providers.custom.models.model.extraBody.__proto__ is not allowed",
    },
    {
      config: { contextCache: "yes" },
      message: "providers.custom.models.model.contextCache must be a boolean",
    },
    {
      config: { supportPdf: "yes" },
      message: "providers.custom.models.model.supportPdf must be a boolean",
    },
    {
      config: { toolContentSupportType: ["audio"] },
      message:
        "providers.custom.models.model.toolContentSupportType[0] must be one of",
    },
    {
      config: { pricing: { input: -1 } },
      message:
        "providers.custom.models.model.pricing.input must be a non-negative number",
    },
    {
      config: { pricing: { tiers: {} } },
      message: "providers.custom.models.model.pricing.tiers must be an array",
    },
    {
      config: { pricing: { tiers: [null] } },
      message:
        "providers.custom.models.model.pricing.tiers[0] must be an object",
    },
    {
      config: { pricing: { tiers: [{ tiers: [] }] } },
      message:
        "providers.custom.models.model.pricing.tiers[0].tiers is not supported",
    },
  ]

  for (const testCase of cases) {
    await withConfig({}, async () => {
      const { server } = await import("../src/server")

      const res = await server.fetch(
        new Request("http://localhost/api/admin/config", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providers: {
              custom: {
                models: {
                  model: testCase.config,
                },
              },
            },
          }),
        }),
      )

      expect(res.status).toBe(400)

      const body = (await res.json()) as { error?: { message?: string } }
      expect(body.error?.message).toContain(testCase.message)
    })
  }
})

test("POST /api/admin/config keeps reasoning max out of config layer", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelReasoningEfforts: {
            "gpt-5.5": "max",
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("modelReasoningEfforts.gpt-5.5")
  })
})

test("POST /api/admin/config rejects case-insensitive duplicate providers", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            Anthropic: { type: "anthropic" },
            anthropic: { type: "anthropic" },
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("conflicts with another provider")
  })
})

test("POST /api/admin/config rejects unsupported provider keys", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            custom: {
              type: "anthropic",
              foo: "bar",
            },
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("providers.custom.foo")
  })
})

test("POST /api/admin/config rejects unsupported provider types", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            custom: {
              type: "openai",
            },
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("providers.custom.type")
  })
})

test("POST /api/admin/config rejects invalid provider authType", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            custom: {
              type: "anthropic",
              authType: "cookie",
            },
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toBe(
      'providers.custom.authType must be one of: "authorization", "oauth2", "x-api-key"',
    )
  })
})

test("POST /api/admin/config round-trips sessionAffinityRetentionDays", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const postRes = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionAffinityRetentionDays: 14 }),
      }),
    )

    expect(postRes.status).toBe(200)

    const postBody = (await postRes.json()) as {
      sessionAffinityRetentionDays?: number
    }
    expect(postBody.sessionAffinityRetentionDays).toBe(14)

    const getRes = await server.fetch(
      new Request("http://localhost/api/admin/config"),
    )

    expect(getRes.status).toBe(200)

    const getBody = (await getRes.json()) as {
      sessionAffinityRetentionDays?: number
    }
    expect(getBody.sessionAffinityRetentionDays).toBe(14)
  })
})

test("POST /api/admin/config rejects negative sessionAffinityRetentionDays", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionAffinityRetentionDays: -1 }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toBe(
      "sessionAffinityRetentionDays must be a non-negative number",
    )
  })
})

test("POST /api/admin/config rejects unknown top-level config keys", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          notARealKey: true,
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("Unknown config key: notARealKey")
  })
})

test("GET /api/admin/config returns default quotaRefresh config", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config"),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      quotaRefresh?: {
        enabled?: boolean
        intervalMinutes?: number
        startupDelaySeconds?: number
        staggerMinSeconds?: number
        staggerMaxSeconds?: number
      }
    }
    expect(body.quotaRefresh).toEqual({
      enabled: true,
      intervalMinutes: 360,
      startupDelaySeconds: 60,
      staggerMinSeconds: 2,
      staggerMaxSeconds: 5,
    })
  })
})

test("POST /api/admin/config updates quotaRefresh and clamps short positive interval", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          quotaRefresh: {
            enabled: true,
            intervalMinutes: 5,
            startupDelaySeconds: 0,
            staggerMinSeconds: 7,
            staggerMaxSeconds: 3,
          },
        }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      quotaRefresh?: {
        enabled?: boolean
        intervalMinutes?: number
        startupDelaySeconds?: number
        staggerMinSeconds?: number
        staggerMaxSeconds?: number
      }
    }
    expect(body.quotaRefresh).toEqual({
      enabled: true,
      intervalMinutes: 30,
      startupDelaySeconds: 0,
      staggerMinSeconds: 7,
      staggerMaxSeconds: 7,
    })
  })
})

test("POST /api/admin/config merges partial quotaRefresh updates", async () => {
  await withConfig(
    {
      quotaRefresh: {
        enabled: true,
        intervalMinutes: 120,
        startupDelaySeconds: 10,
        staggerMinSeconds: 4,
        staggerMaxSeconds: 8,
      },
    },
    async () => {
      const { server } = await import("../src/server")

      const postRes = await server.fetch(
        new Request("http://localhost/api/admin/config", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            quotaRefresh: {
              enabled: false,
            },
          }),
        }),
      )

      expect(postRes.status).toBe(200)

      const postBody = (await postRes.json()) as {
        quotaRefresh?: {
          enabled?: boolean
          intervalMinutes?: number
          startupDelaySeconds?: number
          staggerMinSeconds?: number
          staggerMaxSeconds?: number
        }
      }
      expect(postBody.quotaRefresh).toEqual({
        enabled: false,
        intervalMinutes: 120,
        startupDelaySeconds: 10,
        staggerMinSeconds: 4,
        staggerMaxSeconds: 8,
      })

      const getRes = await server.fetch(
        new Request("http://localhost/api/admin/config"),
      )

      expect(getRes.status).toBe(200)

      const getBody = (await getRes.json()) as typeof postBody
      expect(getBody.quotaRefresh).toEqual(postBody.quotaRefresh)
    },
  )
})

test("POST /api/admin/config refreshes the running quota scheduler config", async () => {
  await withConfig({}, async () => {
    const runtime = await import("../src/lib/quota-refresh-scheduler-runtime")
    const originalStart = runtime.quotaRefreshScheduler.start.bind(
      runtime.quotaRefreshScheduler,
    )
    const originalStop = runtime.quotaRefreshScheduler.stop.bind(
      runtime.quotaRefreshScheduler,
    )
    const originalUpdateConfig =
      runtime.quotaRefreshScheduler.updateConfig.bind(
        runtime.quotaRefreshScheduler,
      )
    let starts = 0
    let updates = 0

    runtime.quotaRefreshScheduler.start = () => {
      starts += 1
    }
    runtime.quotaRefreshScheduler.stop = () => {}
    runtime.quotaRefreshScheduler.updateConfig = () => {
      updates += 1
    }

    try {
      runtime.startQuotaRefreshSchedulerFromConfig()
      const { server } = await import("../src/server")

      const res = await server.fetch(
        new Request("http://localhost/api/admin/config", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            quotaRefresh: {
              enabled: false,
            },
          }),
        }),
      )

      expect(res.status).toBe(200)
      expect(starts).toBe(1)
      expect(updates).toBe(1)
    } finally {
      runtime.quotaRefreshScheduler.start = originalStart
      runtime.quotaRefreshScheduler.stop = originalStop
      runtime.quotaRefreshScheduler.updateConfig = originalUpdateConfig
      runtime.stopQuotaRefreshScheduler()
    }
  })
})

test("POST /api/admin/config updates useResponsesApiContextManagement to false then true", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res1 = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ useResponsesApiContextManagement: false }),
      }),
    )
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as {
      useResponsesApiContextManagement?: boolean
    }
    expect(body1.useResponsesApiContextManagement).toBe(false)

    const res2 = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ useResponsesApiContextManagement: true }),
      }),
    )
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as {
      useResponsesApiContextManagement?: boolean
    }
    expect(body2.useResponsesApiContextManagement).toBe(true)
  })
})

test("POST /api/admin/config clears useResponsesApiContextManagement to default", async () => {
  await withConfig({ useResponsesApiContextManagement: false }, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ useResponsesApiContextManagement: null }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      useResponsesApiContextManagement?: boolean
    }
    expect(body.useResponsesApiContextManagement).toBe(true)
  })
})

test("POST /api/admin/config rejects non-boolean useResponsesApiContextManagement", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ useResponsesApiContextManagement: "false" }),
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain(
      "useResponsesApiContextManagement must be a boolean",
    )
  })
})

test("POST /api/admin/config rejects invalid quotaRefresh fields", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          quotaRefresh: {
            enabled: "yes",
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toBe("quotaRefresh.enabled must be a boolean")
  })
})
