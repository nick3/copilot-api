import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { initAdminDb } from "~/lib/admin-db"
import {
  createRequestOutboundStore,
  type OutboundCaptureInput,
} from "~/lib/request-outbound"

function seedLog(db: Database, requestId: string): void {
  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream)
     VALUES (?, 1, 'POST', '/v1/messages', 0);`,
    [requestId],
  )
}

function makeInput(
  overrides: Partial<OutboundCaptureInput>,
): OutboundCaptureInput {
  return {
    requestId: "req-1",
    httpStatus: 400,
    upstreamUrl: "https://api.githubcopilot.com/v1/messages",
    upstreamMethod: "POST",
    requestHeaders: {
      Authorization: "Bearer REAL_TOKEN",
      "x-request-id": "abc",
    },
    requestBody: '{"model":"x"}',
    requestBodyKind: "json",
    responseStatus: 400,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"error":"bad request"}',
    responseBodyKind: "json",
    ...overrides,
  }
}

test("insert + getByRequestId round-trips and redacts Authorization", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  seedLog(db, "req-1")

  const store = createRequestOutboundStore(db)
  store.insert(makeInput({}))

  const row = store.getByRequestId("req-1")
  expect(row).not.toBeNull()

  if (!row) {
    throw new Error("expected outbound row")
  }

  expect(row.requestHeaders["Authorization"]).toBe("***")
  expect(row.requestHeaders["x-request-id"]).toBe("abc")
  expect(row.requestBody).toBe('{"model":"x"}')
  expect(row.responseStatus).toBe(400)
})

test("cleanupOrphans removes rows whose request_log entry is gone", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  seedLog(db, "req-orphan")

  const store = createRequestOutboundStore(db)
  store.insert(makeInput({ requestId: "req-orphan" }))

  db.run("PRAGMA foreign_keys = OFF;")
  db.run("DELETE FROM request_log WHERE request_id = 'req-orphan';")
  db.run("PRAGMA foreign_keys = ON;")

  expect(store.getByRequestId("req-orphan")).not.toBeNull()
  store.cleanupOrphans()
  expect(store.getByRequestId("req-orphan")).toBeNull()
})

test("getByRequestId returns null when missing", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = createRequestOutboundStore(db)
  expect(store.getByRequestId("does-not-exist")).toBeNull()
})
