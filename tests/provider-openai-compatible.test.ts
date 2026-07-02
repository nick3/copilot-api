import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"

type ProviderModels = NonNullable<ResolvedProviderConfig["models"]>

let providerModels: ProviderModels = {}
let providerBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode"
let providerName = "dash"

const defaultProviderModels: ProviderModels = {
  "qwen-plus": {
    extraBody: {
      enable_thinking: true,
      preserve_thinking: true,
      temperature: 0.9,
    },
    temperature: 0.2,
    toolContentSupportType: [],
    topK: 50,
    topP: 0.8,
  },
}

const getTestProviderConfig = (
  provider: string,
): ResolvedProviderConfig | null => {
  if (provider !== providerName) {
    return null
  }

  return {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: providerBaseUrl,
    models: providerModels,
    name: providerName,
    type: "openai-compatible",
  }
}

const setProviderModels = (models: ProviderModels = defaultProviderModels) => {
  providerModels = models
}

const setProviderIdentity = (
  options: { baseUrl?: string; name?: string } = {},
) => {
  providerBaseUrl =
    options.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode"
  providerName = options.name ?? "dash"
}

const { providerMessageRoutes } =
  await import("../src/routes/provider/messages/route")

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "qwen-plus",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              reasoning_content: "thinking text",
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
          prompt_tokens_details: {
            cache_creation_input_tokens: 2,
            cached_tokens: 1,
          },
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createApp = () => {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("providerConfigResolver" as never, getTestProviderConfig as never)
    c.set("providerFetch" as never, fetchMock as never)
    await next()
  })
  app.route("/:provider/v1/messages", providerMessageRoutes)
  return app
}

beforeEach(() => {
  setProviderModels()
  setProviderIdentity()
  fetchMock.mockClear()
})

describe("openai-compatible provider messages", () => {
  test("translates Anthropic messages to OpenAI chat completions", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        enable_thinking: false,
        temperature: 0.4,
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    )
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })

    const body = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body).toMatchObject({
      enable_thinking: false,
      max_tokens: 128,
      model: "qwen-plus",
      preserve_thinking: true,
      temperature: 0.4,
      top_k: 50,
      top_p: 0.8,
    })
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: {
              type: "ephemeral",
            },
          },
        ],
      },
    ])
    expect(body).not.toHaveProperty("stream_options")

    const json = (await response.json()) as Record<string, unknown>
    expect(json).toMatchObject({
      model: "qwen-plus",
      role: "assistant",
      stop_reason: "end_turn",
      usage: {
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
        input_tokens: 5,
        output_tokens: 2,
      },
    })
    expect(json.content).toEqual([
      {
        type: "thinking",
        thinking: "thinking text",
        signature: "",
      },
      {
        type: "text",
        text: "answer text",
      },
    ])
  })

  test("adds stream_options include_usage for OpenAI-compatible streams", async () => {
    setProviderModels({
      "qwen-plus": {
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({
      include_usage: true,
    })
  })

  test("allows extraBody to disable parallel tool calls", async () => {
    setProviderModels({
      "qwen-plus": {
        extraBody: {
          parallel_tool_calls: false,
        },
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.parallel_tool_calls).toBe(false)
  })

  test("maps Anthropic thinking budget to OpenAI-compatible thinking_budget", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(4096)
    expect(body).not.toHaveProperty("thinking")
  })

  test("forces thinking_budget from extraBody over request thinking budget", async () => {
    setProviderModels({
      "qwen-plus": {
        extraBody: {
          thinking_budget: 8192,
        },
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(8192)
  })
})

describe("openai-compatible provider context cache", () => {
  test("marks first system and last non-system message for OpenAI-compatible context cache", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second" },
          { role: "assistant", content: "second answer" },
          { role: "user", content: "latest" },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const markedMessages = body.messages.filter(
      (message) =>
        Array.isArray(message.content)
        && message.content.some(
          (part) =>
            typeof part === "object"
            && part !== null
            && "cache_control" in part,
        ),
    )

    expect(markedMessages).toHaveLength(2)
    expect(body.messages[0]).toEqual({
      role: "system",
      content: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "first",
    })
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "first answer",
    })
    expect(body.messages[3]).toEqual({
      role: "user",
      content: "second",
    })
    expect(body.messages[4]).toEqual({
      role: "assistant",
      content: "second answer",
    })
    expect(body.messages[5]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "latest",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("allows disabling OpenAI-compatible context cache per model", async () => {
    setProviderModels({
      "qwen-plus": {
        contextCache: false,
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages).toEqual([
      {
        role: "system",
        content: "system prompt",
      },
      {
        role: "user",
        content: "hello",
      },
    ])
  })
})

describe("openai-compatible provider message content", () => {
  test("sends assistant thinking history as reasoning_content", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: "first",
          },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "empty signature thinking",
                signature: "",
              },
              {
                type: "text",
                text: "previous answer",
              },
            ],
          },
          {
            role: "user",
            content: "continue",
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[1]).toMatchObject({
      content: [
        {
          type: "text",
          text: "previous answer",
        },
      ],
      reasoning_content: "empty signature thinking",
      role: "assistant",
    })
    expect(body.messages[1]).not.toHaveProperty("reasoning_text")
    expect(body.messages[1]).not.toHaveProperty("reasoning_opaque")
  })
})

describe("openai-compatible provider tool array content", () => {
  test("marks string tool result content for context cache", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_text",
                content: "plain tool result",
              },
            ],
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_text",
      content: [
        {
          type: "text",
          text: "plain tool result",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("marks tool result array content when array tool content is enabled", async () => {
    setProviderModels({
      "qwen-plus": {
        toolContentSupportType: ["array"],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_text",
                content: [
                  {
                    type: "text",
                    text: "first line",
                  },
                  {
                    type: "text",
                    text: "second line",
                  },
                ],
              },
            ],
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_text",
      content: [
        {
          type: "text",
          text: "first line",
        },
        {
          type: "text",
          text: "second line",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })
})

describe("openai-compatible provider PDF message content", () => {
  test("sends PDF tool results as file parts when PDF tool content is enabled", async () => {
    setProviderModels({
      "qwen-plus": {
        supportPdf: true,
        toolContentSupportType: ["pdf"],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_pdf",
                content: [
                  {
                    type: "text",
                    text: "PDF file read: report.pdf",
                  },
                  {
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: "application/pdf",
                      data: "pdf-data",
                    },
                    title: "report.pdf",
                  },
                ],
              },
            ],
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_pdf",
      content: [
        {
          type: "text",
          text: "PDF file read: report.pdf",
        },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,pdf-data",
            filename: "report.pdf",
          },
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("moves PDF file parts to user messages when tool PDF support is missing", async () => {
    setProviderModels({
      "qwen-plus": {
        supportPdf: true,
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_pdf",
                content: [
                  {
                    type: "text",
                    text: "PDF file read: report.pdf",
                  },
                  {
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: "application/pdf",
                      data: "pdf-data",
                    },
                    title: "report.pdf",
                  },
                ],
              },
            ],
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_pdf",
      content: "PDF file read: report.pdf",
    })
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Tool result for tool_pdf:",
        },
        {
          type: "text",
          text: "PDF file read: report.pdf",
        },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,pdf-data",
            filename: "report.pdf",
          },
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })
})

describe("non-dashscope openai-compatible provider restrictions", () => {
  test("strips request-derived thinking_budget for non-dashscope providers", async () => {
    setProviderIdentity({
      baseUrl: "https://api.example.com/v1",
      name: "custom",
    })
    setProviderModels({
      "qwen-plus": {
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("thinking_budget")
  })

  test("keeps extraBody thinking_budget for non-dashscope providers", async () => {
    setProviderIdentity({
      baseUrl: "https://api.example.com/v1",
      name: "custom",
    })
    setProviderModels({
      "qwen-plus": {
        extraBody: {
          thinking_budget: 8192,
        },
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(8192)
  })

  test("does not apply context cache for non-dashscope providers by default", async () => {
    setProviderIdentity({
      baseUrl: "https://api.example.com/v1",
      name: "custom",
    })
    setProviderModels({
      "qwen-plus": {
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    for (const message of body.messages) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (typeof part === "object" && part !== null) {
          expect(part).not.toHaveProperty("cache_control")
        }
      }
    }
  })

  test("applies context cache for non-dashscope providers when explicitly enabled", async () => {
    setProviderIdentity({
      baseUrl: "https://api.example.com/v1",
      name: "custom",
    })
    setProviderModels({
      "qwen-plus": {
        contextCache: true,
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const systemMessage = body.messages[0]
    expect(Array.isArray(systemMessage.content)).toBe(true)
    const systemPart = (
      systemMessage.content as Array<Record<string, unknown>>
    )[0]
    expect(systemPart.cache_control).toEqual({ type: "ephemeral" })
  })
})

describe("dashscope preserve_thinking default", () => {
  test("defaults preserve_thinking to true for dashscope when not set", async () => {
    setProviderModels({
      "qwen-plus": {
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(true)
  })

  test("keeps explicit preserve_thinking false from extraBody", async () => {
    setProviderModels({
      "qwen-plus": {
        extraBody: {
          preserve_thinking: false,
        },
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("does not set preserve_thinking for non-dashscope providers", async () => {
    setProviderIdentity({
      baseUrl: "https://api.example.com/v1",
      name: "custom",
    })
    setProviderModels({
      "qwen-plus": {
        toolContentSupportType: [],
      },
    })

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("preserve_thinking")
  })
})
