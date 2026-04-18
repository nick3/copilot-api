import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import path from "node:path"

import "./shared-admin-db-test-home"

import type { OutboundCaptureRow } from "~/lib/request-outbound"
import type { AccountContext } from "~/lib/types/account"

import * as accountsMod from "~/lib/accounts-manager"
import { getAdminDb } from "~/lib/admin-db"
import { mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { getRequestHistoryStore } from "~/lib/request-history"
import * as outboundMod from "~/lib/request-outbound"
import * as copilotFetchMod from "~/services/copilot/copilot-fetch"

import { replayRoutes } from "../src/routes/admin-api/replay"

type TestConfig = Record<string, unknown>
type SseEvent = { event?: string; data: string }

let outboundRow: OutboundCaptureRow | null = null
let mockAccount: AccountContext | null = null
let mockFetchResponse: Response = new Response('{"ok":true}', {
  status: 200,
  headers: { "content-type": "application/json" },
})

beforeEach(() => {
  spyOn(outboundMod, "getRequestOutboundStore").mockImplementation(
    () =>
      ({
        insert: () => {},
        getByRequestId: () => outboundRow,
        cleanupOrphans: () => {},
        meta: () => ({ dbPath: "", userVersion: 0 }),
      }) as ReturnType<typeof outboundMod.getRequestOutboundStore>,
  )

  spyOn(outboundMod, "getRedactedHeaderKeys").mockImplementation(
    (headers: Record<string, string>) =>
      Object.keys(headers).filter((k) => k.toLowerCase() === "authorization"),
  )

  spyOn(
    accountsMod.accountsManager,
    "getAccountContextById",
  ).mockImplementation((_id: string) => mockAccount)

  spyOn(copilotFetchMod, "copilotFetch").mockImplementation(() =>
    Promise.resolve(mockFetchResponse),
  )
})

afterEach(() => {
  mock.restore()
  outboundRow = null
  mockAccount = null
  mockFetchResponse = new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  try {
    getAdminDb().run("DELETE FROM request_log;")
  } catch {
    // ignore
  }
})

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
    const rc =
      original === null ?
        fs.rm(PATHS.CONFIG_PATH, { force: true })
      : fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    await rc
    mergeConfigWithDefaults()
  }
}

function createApp() {
  const app = new Hono()
  app.route("/", replayRoutes)
  return app
}

function parseSse(body: string): Array<SseEvent> {
  const blocks = body
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  return blocks.map((block) => {
    const lines = block.split("\n")
    let event: string | undefined
    const dataLines: Array<string> = []
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim() || undefined
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim())
      }
    }
    return { event, data: dataLines.join("\n") }
  })
}

function createStreamingResponse(chunks: Array<string>): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk))
        }
        controller.close()
      },
    }),
    {
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "text/event-stream",
        "x-upstream-test": "yes",
      },
    },
  )
}

const VALID_BLOB: OutboundCaptureRow = {
  requestId: "req-replay-stream",
  capturedAtMs: 100000,
  httpStatus: 400,
  upstreamUrl: "https://api.githubcopilot.com/chat/completions",
  upstreamMethod: "POST",
  requestHeaders: {
    Authorization: "***",
    "content-type": "application/json",
    "x-request-id": "abc-123",
  },
  requestBody: '{"model":"claude-sonnet-4.5","messages":[]}',
  requestBodyKind: "json",
  responseStatus: 400,
  responseHeaders: { "content-type": "application/json" },
  responseBody: '{"error":"bad"}',
  responseBodyKind: "json",
}

const VALID_ACCOUNT: AccountContext = {
  accountLogin: "test-user",
  githubToken: "gh-token",
  copilotToken: "copilot-token-fresh",
  accountType: "individual",
  vsCodeVersion: "1.90.0",
}

function insertRequestLog(requestId: string) {
  getRequestHistoryStore().insert({
    requestId,
    startedAtMs: 1,
    method: "POST",
    path: "/v1/messages",
    upstreamEndpoint: "/chat/completions",
    stream: true,
    accountId: "acc-1",
    clientModel: "claude-3-7-sonnet",
    upstreamModel: "claude-sonnet-4.5",
    httpStatus: 200,
  })
}

test("POST replay live mode streams upstream SSE lifecycle events", async () => {
  await withConfig(
    { devMode: { enabled: true, capture4xx: false } },
    async () => {
      outboundRow = { ...VALID_BLOB }
      insertRequestLog("req-replay-stream")
      mockAccount = { ...VALID_ACCOUNT }
      mockFetchResponse = createStreamingResponse([
        'data: {"type":"delta-1"}\n\n',
        'data: {"type":"delta-2"}\n\n',
      ])

      const app = createApp()
      const response = await app.request(
        "http://localhost/requests/req-replay-stream/replay",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: "acc-1", mode: "live" }),
        },
      )

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      )

      const events = parseSse(await response.text())
      const eventNames = events.map((e) => e.event)
      const startIdx = eventNames.indexOf("upstream-start")
      const chunkIdx = eventNames.indexOf("upstream-chunk")
      const doneIdx = eventNames.indexOf("upstream-done")

      expect(startIdx).toBeGreaterThanOrEqual(0)
      expect(chunkIdx).toBeGreaterThan(startIdx)
      expect(doneIdx).toBeGreaterThan(chunkIdx)

      const startData = JSON.parse(events[startIdx].data) as {
        status: number
        headers: Record<string, string>
      }
      expect(startData.status).toBe(200)
      expect(startData.headers["content-type"]).toBe("text/event-stream")
      expect(startData.headers["x-upstream-test"]).toBe("yes")

      const chunkEvents = events.filter((e) => e.event === "upstream-chunk")
      expect(chunkEvents.length).toBeGreaterThanOrEqual(1)
      expect(JSON.parse(chunkEvents[0].data)).toHaveProperty("raw")

      const doneData = JSON.parse(events[doneIdx].data) as {
        durationMs: number
      }
      expect(typeof doneData.durationMs).toBe("number")
      expect(doneData.durationMs).toBeGreaterThanOrEqual(0)
    },
  )
})
