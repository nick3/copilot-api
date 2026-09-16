import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { state } from "~/lib/state"
const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalCodexToken = state.codexAccessToken
const originalCodexAccount = state.codexAccountId
const fetchMock = mock(() =>
  Promise.resolve(new Response("unexpected", { status: 500 })),
)
beforeEach(() => {
  state.copilotToken = "test-token"
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  fetchMock.mockClear()
  const scope = globalThis as unknown as { fetch: typeof fetch }
  scope.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  state.copilotToken = originalCopilotToken
  state.codexAccessToken = originalCodexToken
  state.codexAccountId = originalCodexAccount
  const scope = globalThis as unknown as { fetch: typeof fetch }
  scope.fetch = originalFetch
})
describe("websocket pre-dispatch cancellation", () => {
  test("copilot websocket refuses aborted client", async () => {
    const unit = await import("~/services/copilot/create-responses")
    const client = new AbortController()
    client.abort()
    const error = await getRejectedError(
      unit.createResponses(
        { input: "hello", model: "gpt-test", stream: true },
        {
          clientSignal: client.signal,
          initiator: "user",
          requestId: "request-1",
          transport: "websocket",
          vision: false,
        },
      ),
    )
    expect(error.name).toBe("AbortError")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test("codex websocket refuses aborted client", async () => {
    const unit = await import("~/services/codex/create-responses")
    const client = new AbortController()
    client.abort()
    const error = await getRejectedError(
      unit.forwardCodexResponses(
        { input: "hello", model: "gpt-5.4", stream: true },
        new Headers(),
        undefined,
        { clientSignal: client.signal, transport: "websocket" },
      ),
    )
    expect(error.name).toBe("AbortError")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
describe("copilot messages drain", () => {
  test("non-streaming messages completes after disconnect", async () => {
    const unit = await import("~/services/copilot/create-messages")
    let resolveFetch: (value: Response) => void = () => {}
    let upstreamSignal: AbortSignal | undefined
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const scope = globalThis as unknown as { fetch: typeof fetch }
    scope.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal
      return gate
    }) as unknown as typeof fetch
    const client = new AbortController()
    const pending = unit.createMessages(
      {
        max_tokens: 8,
        messages: [{ content: "hi", role: "user" }],
        model: "claude-test",
      },
      {
        githubToken: "github-test",
        copilotToken: "copilot-test",
        accountType: "individual",
      },
      { clientSignal: client.signal, requestId: "request-1" },
    )
    await Promise.resolve()
    client.abort(new Error("client disconnected"))
    resolveFetch(
      new Response(
        JSON.stringify({
          content: [{ text: "done", type: "text" }],
          model: "claude-test",
          role: "assistant",
        }),
        { headers: { contentType: "application/json" } },
      ),
    )
    const result = (await pending) as unknown as { role: string }
    expect(result.role).toBe("assistant")
    expect(upstreamSignal?.aborted).toBe(false)
  })
})
const getRejectedError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error("done")
  }
  throw new Error("expected rejection")
}
