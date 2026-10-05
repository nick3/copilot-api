import { Hono } from "hono"
import assert from "node:assert/strict"
import { accountsManager } from "../../src/lib/accounts-manager"
import {
  writeConfigToDisk,
  mergeConfigWithDefaults,
} from "../../src/lib/config"
import type { AccountRuntime } from "../../src/lib/types/account"
import { messageRoutes } from "../../src/routes/messages/route"
import { responsesRoutes } from "../../src/routes/responses/route"
import { makeModel } from "../accounts-manager-test-helpers"

const app = new Hono()
  .route("/v1/messages", messageRoutes)
  .route("/v1/responses", responsesRoutes)
const upstreamModel = "claude-opus-5.5"
const alias = "copilot/claude-opus-5.5"
const account: AccountRuntime = {
  id: "second",
  accountType: "individual",
  addedAt: 0,
  githubToken: "test-github",
  copilotToken: "test-copilot",
  tokenBasedBilling: true,
  models: {
    object: "list",
    data: [
      makeModel({ id: upstreamModel, supported_endpoints: ["/v1/messages"] }),
    ],
  },
}
const internals = accountsManager as unknown as {
  accounts: Map<string, AccountRuntime>
  accountOrder: Array<string>
}
internals.accounts.set("first", {
  ...account,
  id: "first",
  models: { object: "list", data: [] },
})
internals.accounts.set("second", account)
internals.accountOrder = ["first", "second"]
const forwarded: Array<string> = []
globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
  if (typeof init?.body !== "string")
    return Promise.resolve(
      Response.json({
        quota_snapshots: {
          premium_interactions: {
            entitlement: 100,
            remaining: 100,
            unlimited: true,
          },
        },
        endpoints: { api: "https://api.githubcopilot.com" },
        token_based_billing: true,
      }),
    )
  const body = JSON.parse(init.body) as {
    model: string
    stream?: boolean
  }
  forwarded.push(body.model)
  const response = {
    id: "msg-test",
    type: "message",
    role: "assistant",
    model: upstreamModel,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  if (!body.stream) return Promise.resolve(Response.json(response))
  const events = [
    {
      type: "message_start",
      message: { ...response, content: [], stop_reason: null },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]
  return Promise.resolve(
    new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    ),
  )
}) as typeof fetch
try {
  for (const target of [
    upstreamModel,
    "claude-opus-5-5",
    "claude-opus-5-5-20261001",
  ]) {
    writeConfigToDisk({
      modelAliases: { [alias]: { target, allowOriginal: false } },
      useResponsesApiWebSocket: false,
    })
    mergeConfigWithDefaults()
    for (const stream of [false, true]) {
      // Repeat with a session ID to cover both affinity miss and affinity hit.
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.request("http://localhost/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-beta": "extended-cache-ttl-2025-04-11",
            "user-agent": "claude-cli/2.1.289 (external, cli)",
          },
          body: JSON.stringify({
            model: alias,
            messages: [{ role: "user", content: "Explain this function." }],
            max_tokens: 100,
            stream,
            metadata: {
              user_id: JSON.stringify({ session_id: "alias-session" }),
            },
          }),
        })
        const text = await response.text()
        assert.equal(response.status, 200, `Messages ${target}: ${text}`)
        assert.equal(forwarded.at(-1), upstreamModel)
      }
    }
    const response = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: alias,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Explain this function." }],
          },
        ],
      }),
    })
    assert.equal(response.status, 200, await response.text())
    assert.equal(forwarded.at(-1), upstreamModel)
  }
  // Alias-only policy must still reject the original model before using the Messages adapter.
  writeConfigToDisk({
    modelAliases: { [alias]: { target: upstreamModel, allowOriginal: false } },
  })
  mergeConfigWithDefaults()
  const blocked = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: upstreamModel, input: [] }),
  })
  assert.equal(blocked.status, 400)
  assert.match(await blocked.text(), /only available via an alias/u)
} finally {
  accountsManager.shutdown()
}
