import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { initAdminDb, openAdminDb } from "~/lib/admin-db"

function countTable(db: Database, name: string): number {
  const row = db
    .query(
      `SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?;`,
    )
    .get(name) as { c: number }
  return row.c
}

test("openAdminDb creates missing parent directories for file databases", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-db-open-"))
  const dbPath = path.join(tempRoot, "nested", "admin.sqlite")

  let db: Database | null = null
  try {
    db = openAdminDb(dbPath)
    db.run("SELECT 1;")

    expect(fs.existsSync(path.dirname(dbPath))).toBe(true)
  } finally {
    db?.close()
    fs.rmSync(tempRoot, { force: true, recursive: true })
  }
})

test("initAdminDb creates Responses item owner request_log columns", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const columns = db.query("PRAGMA table_info(request_log);").all() as Array<{
    name: string
  }>
  const columnNames = columns.map((column) => column.name)

  expect(columnNames).toContain("responses_item_owner_lookup_keys_json")
  expect(columnNames).toContain("responses_item_owner_recorded_keys_json")
})

test("migrateV13 adds Responses item owner columns to v12 databases", () => {
  const db = new Database(":memory:")
  db.run("CREATE TABLE request_log (request_id TEXT PRIMARY KEY);")
  db.run("PRAGMA user_version = 12;")

  initAdminDb(db)

  const columns = db.query("PRAGMA table_info(request_log);").all() as Array<{
    name: string
  }>
  const columnNames = columns.map((column) => column.name)
  const version = (
    db.query("PRAGMA user_version;").get() as { user_version: number }
  ).user_version

  expect(columnNames).toContain("responses_item_owner_lookup_keys_json")
  expect(columnNames).toContain("responses_item_owner_recorded_keys_json")
  expect(version).toBeGreaterThanOrEqual(13)
})

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
