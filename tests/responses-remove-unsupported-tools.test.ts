import { describe, expect, it } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import {
  fillEmptyNamespaceToolDescriptions,
  removeUnsupportedTools,
} from "~/routes/responses/handler"

const makePayload = (tools: ResponsesPayload["tools"]): ResponsesPayload => ({
  model: "gpt-5",
  input: [],
  tools,
})

describe("removeUnsupportedTools", () => {
  it("removes image_generation tools", () => {
    const payload = makePayload([
      { type: "image_generation" },
      { type: "function", name: "foo" },
    ] as ResponsesPayload["tools"])

    removeUnsupportedTools(payload)

    expect(payload.tools).toHaveLength(1)
    expect((payload.tools as Array<{ type: string }>)[0].type).toBe("function")
  })

  it("removes image_gen namespace tools", () => {
    const payload = makePayload([
      {
        type: "namespace",
        name: "image_gen",
        tools: [{ type: "function", name: "imagegen" }],
      },
      { type: "function", name: "foo" },
    ] as ResponsesPayload["tools"])

    removeUnsupportedTools(payload)

    expect(payload.tools).toHaveLength(1)
    expect((payload.tools as Array<{ name: string }>)[0].name).toBe("foo")
  })

  it("leaves payload unchanged when no unsupported tools present", () => {
    const tools = [
      { type: "function", name: "foo" },
      { type: "web_search" },
    ] as ResponsesPayload["tools"]
    const payload = makePayload(tools)

    removeUnsupportedTools(payload)

    expect(payload.tools).toHaveLength(2)
  })

  it("is a no-op when tools is missing or empty", () => {
    const empty = makePayload([] as ResponsesPayload["tools"])
    removeUnsupportedTools(empty)
    expect(empty.tools).toEqual([] as ResponsesPayload["tools"])

    const missing = {
      model: "gpt-5",
      input: [],
    } as unknown as ResponsesPayload
    removeUnsupportedTools(missing)
    expect(missing.tools).toBeUndefined()
  })
})

describe("fillEmptyNamespaceToolDescriptions", () => {
  it("uses the namespace name for empty descriptions in request and input tools", () => {
    const payload = makePayload([
      {
        type: "namespace",
        name: "workspace",
        description: "",
        tools: [],
      },
      {
        type: "namespace",
        name: "browser",
        description: "Browser tools",
        tools: [],
      },
      { type: "function", name: "empty_function", description: "" },
    ] as ResponsesPayload["tools"])
    payload.input = [
      {
        type: "tool_search_output",
        call_id: "call_search",
        tools: [
          {
            type: "namespace",
            name: "mcp__fetch",
            description: "",
            tools: [],
          },
        ],
      },
    ]

    fillEmptyNamespaceToolDescriptions(payload)

    expect(payload.tools?.[0]).toMatchObject({
      description: "workspace",
      name: "workspace",
      type: "namespace",
    })
    expect(payload.tools?.[1]).toMatchObject({
      description: "Browser tools",
      name: "browser",
      type: "namespace",
    })
    expect(payload.tools?.[2]).toMatchObject({
      description: "",
      name: "empty_function",
      type: "function",
    })
    expect(
      (
        payload.input[0] as {
          tools: Array<{ description: string }>
        }
      ).tools[0].description,
    ).toBe("mcp__fetch")
  })

  it("is a no-op when input and tools do not contain tool definitions", () => {
    const payload = {
      input: "hello",
      model: "gpt-5",
      tools: null,
    } satisfies ResponsesPayload

    fillEmptyNamespaceToolDescriptions(payload)

    expect(payload).toEqual({
      input: "hello",
      model: "gpt-5",
      tools: null,
    })
  })
})
