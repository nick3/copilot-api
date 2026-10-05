import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import {
  getProviderConfig,
  mergeConfigWithDefaults,
  resolveProviderAuthType,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"

import {
  buildProviderUpstreamHeaders,
  resolveProviderEndpointUrl,
} from "../src/services/providers/provider-proxy"

function createProviderConfig(
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  return {
    name: "custom",
    type: "anthropic",
    baseUrl: "https://example.com",
    apiKey: "provider-key",
    authType: "x-api-key",
    ...overrides,
  }
}

async function withConfig(
  config: Record<string, unknown>,
  run: () => void | Promise<void>,
): Promise<void> {
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
    const restoreConfig =
      original === null ?
        fs.rm(PATHS.CONFIG_PATH, { force: true })
      : fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    await restoreConfig
    mergeConfigWithDefaults()
  }
}

describe("getProviderConfig", () => {
  test("defaults authType to x-api-key when omitted", async () => {
    await withConfig(
      {
        providers: {
          custom: {
            type: "anthropic",
            enabled: true,
            baseUrl: "https://example.com",
            apiKey: "provider-key",
          },
        },
      },
      () => {
        expect(getProviderConfig("custom")).toMatchObject({
          name: "custom",
          type: "anthropic",
          baseUrl: "https://example.com",
          apiKey: "provider-key",
          authType: "x-api-key",
          adjustInputTokens: undefined,
          models: undefined,
        })
      },
    )
  })

  test("falls back to provider default for invalid authType", async () => {
    await withConfig(
      {
        providers: {
          custom: {
            type: "anthropic",
            enabled: true,
            baseUrl: "https://example.com",
            apiKey: "provider-key",
            authType: "cookie",
          },
        },
      },
      () => {
        expect(getProviderConfig("custom")).toMatchObject({
          name: "custom",
          type: "anthropic",
          baseUrl: "https://example.com",
          apiKey: "provider-key",
          authType: "x-api-key",
          adjustInputTokens: undefined,
          models: undefined,
        })
      },
    )
  })
})

describe("buildProviderUpstreamHeaders", () => {
  test("uses x-api-key auth by default", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig(),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "provider-key",
      "anthropic-version": "2023-06-01",
    })
  })

  test("uses Authorization bearer auth when configured", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ authType: "authorization" }),
      new Headers({
        accept: "application/json",
        "user-agent": "test-client",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
      "user-agent": "test-client",
    })
  })

  test("does not forward Anthropic-only headers to OpenAI-compatible providers", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({
        authType: "authorization",
        type: "openai-compatible",
      }),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })
  })

  test("sets an Anthropic API version for a selected models.dev provider", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ modelsDevProviderId: "anthropic-provider" }),
      new Headers(),
    )
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["x-api-key"]).toBe("provider-key")
  })
})

describe("resolveProviderAuthType", () => {
  test("falls back to OpenAI-compatible default for invalid authType", () => {
    expect(
      resolveProviderAuthType("dash", "invalid-auth-type", "openai-compatible"),
    ).toBe("authorization")
  })

  test("falls back to Anthropic default for invalid authType", () => {
    expect(
      resolveProviderAuthType("custom", "invalid-auth-type", "anthropic"),
    ).toBe("x-api-key")
  })

  test("falls back for non-codex oauth2 providers", () => {
    expect(
      resolveProviderAuthType("custom", "oauth2", "openai-responses"),
    ).toBe("authorization")
  })
})

describe("provider endpoint URL", () => {
  test("uses models.dev API paths directly for all three supported protocols", () => {
    const provider = createProviderConfig({
      baseUrl: "https://api.example.com/anthropic/v1",
      modelsDevProviderId: "example",
    })
    expect(resolveProviderEndpointUrl(provider, "messages")).toBe(
      "https://api.example.com/anthropic/v1/messages",
    )
    expect(resolveProviderEndpointUrl(provider, "chat/completions")).toBe(
      "https://api.example.com/anthropic/v1/chat/completions",
    )
    expect(resolveProviderEndpointUrl(provider, "responses")).toBe(
      "https://api.example.com/anthropic/v1/responses",
    )
  })

  test("does not duplicate a catalog URL's final chat endpoint", () => {
    expect(
      resolveProviderEndpointUrl(
        createProviderConfig({
          baseUrl: "https://api.example.com/v1/chat/completions",
          modelsDevProviderId: "example",
        }),
        "chat/completions",
      ),
    ).toBe("https://api.example.com/v1/chat/completions")
  })

  test("preserves the existing manual-provider URL convention", () => {
    expect(
      resolveProviderEndpointUrl(
        createProviderConfig({ baseUrl: "https://api.example.com/api" }),
        "chat/completions",
      ),
    ).toBe("https://api.example.com/api/v1/chat/completions")
  })
})
