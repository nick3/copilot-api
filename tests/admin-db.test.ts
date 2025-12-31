import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import {
  getAdminDb,
  getAdminDbPath,
  getAdminDbUserVersion,
  initAdminDb,
  openAdminDb,
} from "../src/lib/admin-db"

test("openAdminDb creates in-memory database", () => {
  const db = openAdminDb(":memory:")

  expect(db).toBeDefined()
  expect(db.query).toBeDefined()
})

test("initAdminDb sets up pragmas and tables", () => {
  const db = new Database(":memory:")

  initAdminDb(db)

  const journalMode = db
    .query("PRAGMA journal_mode;")
    .get() as { journal_mode: string } | null
  expect(journalMode?.journal_mode).toBe("wal")

  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='request_log';",
    )
    .all()
  expect(tables.length).toBe(1)
})

test("getAdminDbUserVersion returns 0 for uninitialized db", () => {
  const db = new Database(":memory:")

  expect(getAdminDbUserVersion(db)).toBe(0)
})

test("getAdminDbUserVersion returns 1 after migration", () => {
  const db = new Database(":memory:")

  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(1)
})

test("initAdminDb is idempotent", () => {
  const db = new Database(":memory:")

  initAdminDb(db)
  const version1 = getAdminDbUserVersion(db)

  initAdminDb(db)
  const version2 = getAdminDbUserVersion(db)

  expect(version1).toBe(version2)
  expect(version1).toBe(1)
})

test("request_log table has expected columns", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const cols = db
    .query("PRAGMA table_info(request_log);")
    .all() as Array<{ name: string }>

  const colNames = cols.map((c) => c.name)

  expect(colNames).toContain("request_id")
  expect(colNames).toContain("started_at_ms")
  expect(colNames).toContain("account_id")
  expect(colNames).toContain("upstream_model")
  expect(colNames).toContain("tokens_total")
  expect(colNames).toContain("http_status")
  expect(colNames).toContain("error_name")
})

test("request_log has indexes", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const indexes = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='request_log';",
    )
    .all() as Array<{ name: string }>

  const indexNames = indexes.map((i) => i.name)

  expect(indexNames).toContain("idx_request_log_started_at")
  expect(indexNames).toContain("idx_request_log_account_started_at")
  expect(indexNames).toContain("idx_request_log_model_started_at")
})

test("getAdminDbPath returns expected path", () => {
  const path = getAdminDbPath()

  expect(path).toContain("admin.sqlite")
})

test("getAdminDb returns shared singleton instance", () => {
  const db1 = getAdminDb()
  const db2 = getAdminDb()

  expect(db1).toBe(db2)
})