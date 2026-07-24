import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")

let codexProviderConfig: ResolvedProviderConfig | null = null
let openrouterProviderConfig: ResolvedProviderConfig | null = null

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => {
    if (provider === "codex") return codexProviderConfig
    if (provider === "openrouter") return openrouterProviderConfig
    return null
  },
  getRawProviderConfig: (provider: string) => {
    if (provider === "codex") return codexProviderConfig
    if (provider === "openrouter") return openrouterProviderConfig
    return null
  },
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

const { state } = await import("../src/lib/state")
const { resetLoggerRuntimeForTests } = await import("../src/lib/logger")
const { forwardCodexImages, resolveCodexImagesUrl } =
  await import("../src/services/codex/images")
const { imageRouteDependencies, imageRoutes } =
  await import("../src/routes/images/route")
const { providerImageRoutes } =
  await import("../src/routes/provider/images/route")
const { server } = await import("../src/server")

const originalDebugJsonLazy = imageRouteDependencies.debugJsonLazy
let debugValues: Array<unknown> = []
const debugJsonLazyMock = mock(
  async (
    _logger: Parameters<typeof originalDebugJsonLazy>[0],
    _label: string,
    factory: Parameters<typeof originalDebugJsonLazy>[2],
  ) => {
    if (state.verbose) {
      debugValues.push(await factory())
    }
  },
)

const originalFetch = globalThis.fetch
const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          created: 1_784_000_000,
          data: [{ b64_json: "generated-image" }],
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-upstream": "codex",
          },
          status: 200,
        },
      ),
    ),
)

function createApp() {
  const app = new Hono()
  app.route("/images", imageRoutes)
  app.route("/v1/images", imageRoutes)
  app.route("/:provider/v1/images", providerImageRoutes)
  return app
}

beforeEach(() => {
  codexProviderConfig = {
    apiKey: "unused-provider-key",
    authType: "oauth2",
    baseUrl: "https://chatgpt.com/backend-api",
    name: "codex",
    type: "openai-responses",
  }
  openrouterProviderConfig = {
    apiKey: "openrouter-key",
    authType: "authorization",
    baseUrl: "https://openrouter.example",
    name: "openrouter",
    type: "openai-compatible",
  }
  state.codexAccessToken = "codex-access-token"
  state.codexAccountId = "account-123"
  state.verbose = false
  resetLoggerRuntimeForTests(undefined, "info")
  fetchMock.mockClear()
  debugJsonLazyMock.mockClear()
  debugValues = []
  imageRouteDependencies.debugJsonLazy = debugJsonLazyMock
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
  state.verbose = false
  resetLoggerRuntimeForTests()
  openrouterProviderConfig = null
  imageRouteDependencies.debugJsonLazy = originalDebugJsonLazy
})

describe("Codex images URL", () => {
  test("builds the generations URL and preserves query parameters", () => {
    expect(
      resolveCodexImagesUrl(
        "http://localhost/v1/images/generations?client=codex&format=png",
        "generations",
      ),
    ).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?client=codex&format=png",
    )
  })

  test("builds the edits URL", () => {
    expect(resolveCodexImagesUrl("/images/edits", "edits")).toBe(
      "https://chatgpt.com/backend-api/codex/images/edits",
    )
  })

  test("uses a configured Codex API base URL", () => {
    expect(
      resolveCodexImagesUrl(
        "/v1/images/generations?format=png",
        "generations",
        "https://codex.example/backend-api/codex/",
      ),
    ).toBe(
      "https://codex.example/backend-api/codex/images/generations?format=png",
    )
  })
})

describe("Codex images forwarding", () => {
  test("forwards a JSON generation request and Codex auth headers", async () => {
    const payload = {
      model: "gpt-image-2",
      prompt: "A small robot watering a plant",
      quality: "high",
      size: "1024x1024",
    }

    const response = await createApp().request(
      "/images/generations?output=base64",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: "Bearer client-token",
          "content-type": "application/json",
          cookie: "session=test-cookie",
          originator: "codex-tui",
          "user-agent": "codex-tui/test",
          "x-client-header": "kept",
        },
        body: JSON.stringify(payload),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-upstream")).toBe("codex")
    expect(await response.json()).toEqual({
      created: 1_784_000_000,
      data: [{ b64_json: "generated-image" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?output=base64",
    )
    expect(init?.method).toBe("POST")
    expect(init?.duplex).toBe("half")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("cookie")).toBe("session=test-cookie")
    expect(headers.get("originator")).toBe("codex-tui")
    expect(headers.get("user-agent")).toBe("codex-tui/test")
    expect(headers.get("x-client-header")).toBe("kept")
    expect(await new Response(init?.body).json()).toEqual(payload)
  })

  test("preserves multipart fields and file bytes for image edits", async () => {
    state.verbose = true
    const formData = new FormData()
    formData.set("model", "gpt-image-2")
    formData.set("prompt", "Make the background transparent")
    formData.set(
      "image",
      new Blob(["source-image-bytes"], { type: "image/png" }),
      "source.png",
    )

    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")

    const headers = new Headers(init?.headers)
    expect(headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )
    const forwardedResponse = new Response(init?.body, {
      headers,
    })
    const forwardedFormData = await forwardedResponse.formData()
    expect(forwardedFormData.get("model")).toBe("gpt-image-2")
    expect(forwardedFormData.get("prompt")).toBe(
      "Make the background transparent",
    )

    const image = forwardedFormData.get("image")
    expect(image).not.toBeNull()
    expect(typeof image).not.toBe("string")
    if (image === null || typeof image === "string") {
      throw new Error("Expected the forwarded image to be a file")
    }
    expect(image.name).toBe("source.png")
    expect(image.type).toBe("image/png")
    expect(await image.text()).toBe("source-image-bytes")
    expect(debugJsonLazyMock).not.toHaveBeenCalled()
  })

  test("adds JSON defaults when request headers are absent", async () => {
    await forwardCodexImages(
      new Request("http://localhost/images/generations", {
        method: "POST",
        body: new Uint8Array([123, 125]),
      }),
      "generations",
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")
  })

  test("does not label an edit request as JSON when content type is absent", async () => {
    await forwardCodexImages(
      new Request("http://localhost/images/edits", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      }),
      "edits",
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(new Headers(init?.headers).has("content-type")).toBe(false)
  })

  test("logs only the generation request body when debug logging is enabled", async () => {
    state.verbose = true
    const payload = { prompt: "debug body" }

    const response = await createApp().request("/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      created: 1_784_000_000,
      data: [{ b64_json: "generated-image" }],
    })
    expect(debugJsonLazyMock).toHaveBeenCalledTimes(1)
    expect(debugJsonLazyMock.mock.calls[0]?.[1]).toBe(
      "images.generations.codex.request",
    )
    expect(debugValues).toEqual([{ body: JSON.stringify(payload) }])
  })

  test("does not expose image endpoints over GET", async () => {
    const response = await createApp().request("/images/generations")

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("returns 404 when the Codex provider is unavailable", async () => {
    codexProviderConfig = null

    const response = await createApp().request("/images/edits", {
      method: "POST",
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'codex' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("supports the provider-scoped images generations route", async () => {
    const payload = { prompt: "provider path" }

    const response = await createApp().request(
      "/codex/v1/images/generations?output=base64",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    )

    expect(response.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?output=base64",
    )
  })

  test("proxies non-codex providers on the provider-scoped images route", async () => {
    const payload = { prompt: "generic provider image" }

    const response = await createApp().request(
      "/openrouter/v1/images/generations?output=base64",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://openrouter.example/v1/images/generations?output=base64",
    )
    expect(init?.method).toBe("POST")
    expect(init?.duplex).toBe("half")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.get("content-type")).toBe("application/json")
    expect(await new Response(init?.body).json()).toEqual(payload)
  })

  test("reads provider generation bodies at debug log level", async () => {
    resetLoggerRuntimeForTests(undefined, "debug")

    const response = await createApp().request(
      "/openrouter/v1/images/generations",
      {
        method: "POST",
        body: JSON.stringify({ prompt: "debug provider image" }),
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("returns 404 for an unavailable provider-scoped image route", async () => {
    openrouterProviderConfig = null

    const response = await createApp().request(
      "/openrouter/v1/images/generations",
      { method: "POST" },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'openrouter' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("converts provider image failures into gateway errors", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(new Error("provider image failed")),
    )

    const response = await createApp().request(
      "/openrouter/v1/images/generations",
      { method: "POST" },
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { message: "provider image failed", type: "error" },
    })
  })

  test("preserves multipart content-type for non-codex provider image edits", async () => {
    const formData = new FormData()
    formData.set("model", "gpt-image-2")
    formData.set("prompt", "generic edit")
    formData.set(
      "image",
      new Blob(["source-image-bytes"], { type: "image/png" }),
      "source.png",
    )

    const response = await createApp().request("/openrouter/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.example/v1/images/edits")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer openrouter-key")
    expect(headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )
  })
})

test("server registers unversioned, v1, and provider Codex media routes", () => {
  const postPaths = new Set(
    server.routes
      .filter((route) => route.method === "POST")
      .map((route) => route.path),
  )

  const expectedPaths = [
    "/alpha/search",
    "/v1/alpha/search",
    "/images/generations",
    "/images/edits",
    "/v1/images/generations",
    "/v1/images/edits",
    "/:provider/v1/alpha/search",
    "/:provider/v1/images/generations",
    "/:provider/v1/images/edits",
    "/:provider/v1/responses",
    "/:provider/alpha/search",
    "/:provider/images/generations",
    "/:provider/images/edits",
    "/:provider/responses",
  ]
  for (const path of expectedPaths) {
    expect(postPaths.has(path)).toBe(true)
  }

  const getPaths = new Set(
    server.routes
      .filter((route) => route.method === "GET")
      .map((route) => route.path),
  )
  expect(getPaths.has("/:provider/models")).toBe(true)
  expect(getPaths.has("/:provider/v1/models")).toBe(true)

  const routes = server.routes.map((route) => `${route.method} ${route.path}`)
  expect(routes.indexOf("POST /v1/responses")).toBeLessThan(
    routes.indexOf("POST /:provider/responses"),
  )
})
