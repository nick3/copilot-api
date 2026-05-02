import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { getAdminDbUserVersion, initAdminDb } from "../src/lib/admin-db"
import { SessionAffinityStore } from "../src/lib/session-affinity-store"

test("initAdminDb migrates admin DB to user_version 13", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(13)
})

test("initAdminDb upgrades an existing v7 DB with request_log to v13 and creates session_affinity", () => {
  const db = new Database(":memory:")

  db.run(`
    CREATE TABLE request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      duration_ms INTEGER,
      ttfb_ms INTEGER,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      upstream_endpoint TEXT,
      stream INTEGER NOT NULL DEFAULT 0,
      account_id TEXT,
      account_type TEXT,
      cost_units REAL,
      client_model TEXT,
      upstream_model TEXT,
      client_ip TEXT,
      client_ip_source TEXT,
      user_agent TEXT,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_total INTEGER,
      tokens_cached_input INTEGER,
      usage_json TEXT,
      premium_remaining_before REAL,
      premium_remaining_after REAL,
      premium_remaining_diff REAL,
      premium_unlimited_before INTEGER,
      premium_unlimited_after INTEGER,
      http_status INTEGER,
      error_name TEXT,
      error_status INTEGER,
      error_message TEXT,
      selection_failure_reason TEXT,
      user_id TEXT,
      safety_identifier TEXT,
      prompt_cache_key TEXT,
      initiator TEXT,
      upstream_request_id TEXT,
      affinity_hit INTEGER,
      affinity_cache_key TEXT,
      is_subagent INTEGER,
      affinity_key_used TEXT,
      affinity_key_source TEXT,
      selection_reason TEXT,
      upstream_error_message_raw TEXT
    );
  `)
  db.run("PRAGMA user_version = 7;")

  const requestLogColumnsBefore = db
    .query("PRAGMA table_info(request_log);")
    .all() as Array<{ name: string }>
  const columnNamesBefore = requestLogColumnsBefore.map((column) => column.name)

  expect(columnNamesBefore).toContain("upstream_error_message_raw")
  expect(columnNamesBefore).not.toContain("outbound_x_request_id")

  const before = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_affinity' LIMIT 1;",
    )
    .get() as { name?: string } | null

  expect(before).toBeNull()

  initAdminDb(db)

  const after = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_affinity' LIMIT 1;",
    )
    .get() as { name?: string } | null
  const requestLogColumnsAfter = db
    .query("PRAGMA table_info(request_log);")
    .all() as Array<{ name: string }>
  const columnNamesAfter = requestLogColumnsAfter.map((column) => column.name)

  expect(getAdminDbUserVersion(db)).toBe(13)
  expect(after?.name).toBe("session_affinity")
  expect(columnNamesAfter).toContain("outbound_x_request_id")
  expect(columnNamesAfter).toContain("responses_item_owner_lookup_keys_json")
  expect(columnNamesAfter).toContain("responses_item_owner_recorded_keys_json")
})

test("initAdminDb creates session_affinity with the expected columns", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const columns = db
    .query("PRAGMA table_info(session_affinity);")
    .all() as Array<{ name: string }>

  expect(columns.map((column) => column.name)).toEqual([
    "cache_key",
    "account_id",
    "created_at_ms",
    "last_confirmed_at_ms",
    "last_used_at_ms",
  ])
})

test("SessionAffinityStore set/get round-trips the persisted account", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  store.set("session-1:gpt-5.4", "acct-a")

  expect(store.get("session-1:gpt-5.4")).toBe("acct-a")

  const row = db
    .query(
      "SELECT account_id, created_at_ms, last_confirmed_at_ms, last_used_at_ms FROM session_affinity WHERE cache_key = ? LIMIT 1;",
    )
    .get("session-1:gpt-5.4") as {
    account_id: string
    created_at_ms: number
    last_confirmed_at_ms: number
    last_used_at_ms: number
  } | null

  expect(row?.account_id).toBe("acct-a")
  expect(row?.created_at_ms).toBeTypeOf("number")
  expect(row?.last_confirmed_at_ms).toBeTypeOf("number")
  expect(row?.last_used_at_ms).toBeTypeOf("number")
})

test("SessionAffinityStore get returns account when last_used_at_ms update fails", () => {
  let updateAttempts = 0
  const selectSql =
    "SELECT account_id FROM session_affinity WHERE cache_key = ? LIMIT 1;"
  const updateSql =
    "UPDATE session_affinity SET last_used_at_ms = ? WHERE cache_key = ?;"

  const db = {
    query(sql: string) {
      if (sql === selectSql) {
        return {
          get() {
            return { account_id: "acct-a" }
          },
        }
      }

      if (sql === updateSql) {
        return {
          run() {
            updateAttempts += 1
            throw new Error("update failed")
          },
        }
      }

      throw new Error(`Unexpected query: ${sql}`)
    },
  } as unknown as Database

  const store = new SessionAffinityStore(db)

  expect(store.get("session-1:gpt-5.4")).toBe("acct-a")
  expect(updateAttempts).toBe(1)
})

test("SessionAffinityStore cleanup removes stale rows by last_used_at_ms", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  store.set("stale:gpt-5.4", "acct-old")
  db.query(
    "UPDATE session_affinity SET last_used_at_ms = ? WHERE cache_key = ?;",
  ).run(Date.now() - 10_000, "stale:gpt-5.4")

  store.cleanup(1_000)

  expect(store.get("stale:gpt-5.4")).toBeUndefined()
})
