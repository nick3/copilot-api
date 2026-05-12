import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { getLogLevel, mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"

type TestConfig = Record<string, unknown>

const withConfig = async (config: TestConfig, run: () => Promise<void>) => {
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
              type: "anthropic",
              enabled: true,
              baseUrl: "https://example.com",
              apiKey: "sk-test",
              authType: "authorization",
              adjustInputTokens: true,
              models: {
                "kimi-k2.5": {
                  temperature: 1,
                  topP: 0.95,
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
          adjustInputTokens: boolean
          models: {
            "kimi-k2.5": {
              temperature: number
              topP: number
            }
          }
        }
      }
    }

    expect(body.providers.custom.type).toBe("anthropic")
    expect(body.providers.custom.enabled).toBe(true)
    expect(body.providers.custom.baseUrl).toBe("https://example.com")
    expect(body.providers.custom.apiKey).toBe("sk-test")
    expect(body.providers.custom.authType).toBe("authorization")
    expect(body.providers.custom.adjustInputTokens).toBe(true)
    expect(body.providers.custom.models["kimi-k2.5"].temperature).toBe(1)
    expect(body.providers.custom.models["kimi-k2.5"].topP).toBe(0.95)
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
      'providers.custom.authType must be one of: "authorization", "x-api-key"',
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
