import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { initAdminDb } from "~/lib/admin-db"

function countTable(db: Database, name: string): number {
  const row = db
    .query(
      `SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?;`,
    )
    .get(name) as { c: number }
  return row.c
}

test("migrateV11 creates request_outbound with FK cascade", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(countTable(db, "request_outbound")).toBe(1)

  const version = (
    db.query("PRAGMA user_version;").get() as { user_version: number }
  ).user_version
  expect(version).toBeGreaterThanOrEqual(11)

  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream)
     VALUES ('req-1', 1, 'POST', '/v1/messages', 0);`,
  )
  db.run(
    `INSERT INTO request_outbound (
       request_id, captured_at_ms, http_status,
       upstream_url, upstream_method,
       request_headers, request_body, request_body_kind,
       response_status, response_headers, response_body, response_body_kind
     ) VALUES ('req-1', 1, 400, 'https://x', 'POST', '{}', null, 'json', 400, '{}', null, 'json');`,
  )

  expect(
    (
      db.query("SELECT count(*) AS c FROM request_outbound;").get() as {
        c: number
      }
    ).c,
  ).toBe(1)

  db.run("DELETE FROM request_log WHERE request_id = 'req-1';")

  expect(
    (
      db.query("SELECT count(*) AS c FROM request_outbound;").get() as {
        c: number
      }
    ).c,
  ).toBe(0)
})
