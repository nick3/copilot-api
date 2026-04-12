import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { getAdminDbUserVersion, initAdminDb } from "../src/lib/admin-db"
import { SessionAffinityStore } from "../src/lib/session-affinity-store"

test("initAdminDb migrates admin DB to user_version 8", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(8)
})

test("initAdminDb upgrades an existing v7 DB to v8 and creates session_affinity", () => {
  const db = new Database(":memory:")

  db.run("PRAGMA user_version = 7;")

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

  expect(getAdminDbUserVersion(db)).toBe(8)
  expect(after?.name).toBe("session_affinity")
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

  const db = {
    query(sql: string) {
      if (sql === "SELECT account_id FROM session_affinity WHERE cache_key = ? LIMIT 1;") {
        return {
          get() {
            return { account_id: "acct-a" }
          },
        }
      }

      if (sql === "UPDATE session_affinity SET last_used_at_ms = ? WHERE cache_key = ?;") {
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
