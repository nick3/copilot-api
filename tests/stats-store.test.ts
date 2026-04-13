import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { getAdminDbUserVersion, initAdminDb } from "../src/lib/admin-db"
import { StatsStore, toLocalDateString } from "../src/lib/stats-store"

test("initAdminDb migrates admin DB to user_version 9", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(9)
})

test("daily_premium_stats table has the expected columns", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const columns = db
    .query("PRAGMA table_info(daily_premium_stats);")
    .all() as Array<{ name: string }>

  expect(columns.map((c) => c.name)).toEqual([
    "date",
    "account_id",
    "request_count",
    "cost_units_sum",
    "tokens_total",
    "error_count",
    "updated_at_ms",
  ])
})

test("v9 migration backfills from existing request_log data", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  // Reset to v8 and drop the stats table so we can test the backfill
  db.run("PRAGMA user_version = 8;")
  db.run("DROP TABLE IF EXISTS daily_premium_stats;")

  // Insert test data into request_log
  const baseMs = new Date("2026-04-10T12:00:00").getTime()
  db.run(
    `INSERT INTO request_log
       (request_id, started_at_ms, method, path, account_id, cost_units, tokens_total, error_name)
     VALUES
       ('req-1', ?, 'POST', '/v1/messages', 'acct-a', 10.0, 1000, NULL),
       ('req-2', ?, 'POST', '/v1/messages', 'acct-a', 5.0,  500,  'RateLimit'),
       ('req-3', ?, 'POST', '/v1/messages', 'acct-b', 8.0,  800,  NULL)`,
    [baseMs, baseMs + 1000, baseMs + 2000],
  )

  // Re-run migration (should trigger v9 since user_version is 8)
  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(9)

  const rows = db
    .query(
      "SELECT date, account_id, request_count, cost_units_sum, tokens_total, error_count FROM daily_premium_stats ORDER BY account_id",
    )
    .all() as Array<{
    date: string
    account_id: string
    request_count: number
    cost_units_sum: number
    tokens_total: number
    error_count: number
  }>

  expect(rows.length).toBe(2)

  const acctA = rows.find((r) => r.account_id === "acct-a")
  expect(acctA).toBeDefined()
  expect(acctA?.request_count).toBe(2)
  expect(acctA?.cost_units_sum).toBe(15.0)
  expect(acctA?.tokens_total).toBe(1500)
  expect(acctA?.error_count).toBe(1)

  const acctB = rows.find((r) => r.account_id === "acct-b")
  expect(acctB).toBeDefined()
  expect(acctB?.request_count).toBe(1)
  expect(acctB?.cost_units_sum).toBe(8.0)
  expect(acctB?.tokens_total).toBe(800)
  expect(acctB?.error_count).toBe(0)
})

test("upsertDailyStats creates new rows", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const startedAtMs = new Date("2026-04-10T14:30:00").getTime()
  store.upsertDailyStats({
    startedAtMs,
    accountId: "acct-a",
    costUnits: 10.0,
    tokensTotal: 1000,
    hasError: false,
  })

  const rows = db.query("SELECT * FROM daily_premium_stats").all() as Array<{
    date: string
    account_id: string
    request_count: number
    cost_units_sum: number
    tokens_total: number
    error_count: number
  }>

  expect(rows.length).toBe(1)
  expect(rows[0].date).toBe(toLocalDateString(startedAtMs))
  expect(rows[0].account_id).toBe("acct-a")
  expect(rows[0].request_count).toBe(1)
  expect(rows[0].cost_units_sum).toBe(10.0)
  expect(rows[0].tokens_total).toBe(1000)
  expect(rows[0].error_count).toBe(0)
})

test("upsertDailyStats accumulates on same date+account", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const startedAtMs = new Date("2026-04-10T10:00:00").getTime()

  store.upsertDailyStats({
    startedAtMs,
    accountId: "acct-a",
    costUnits: 10.0,
    tokensTotal: 1000,
    hasError: false,
  })

  store.upsertDailyStats({
    startedAtMs: startedAtMs + 3600_000, // 1 hour later, same day
    accountId: "acct-a",
    costUnits: 5.0,
    tokensTotal: 500,
    hasError: true,
  })

  const rows = db.query("SELECT * FROM daily_premium_stats").all() as Array<{
    request_count: number
    cost_units_sum: number
    tokens_total: number
    error_count: number
  }>

  expect(rows.length).toBe(1)
  expect(rows[0].request_count).toBe(2)
  expect(rows[0].cost_units_sum).toBe(15.0)
  expect(rows[0].tokens_total).toBe(1500)
  expect(rows[0].error_count).toBe(1)
})

test("upsertDailyStats creates separate rows for different accounts", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const startedAtMs = new Date("2026-04-10T10:00:00").getTime()

  store.upsertDailyStats({
    startedAtMs,
    accountId: "acct-a",
    costUnits: 10.0,
    tokensTotal: 1000,
    hasError: false,
  })

  store.upsertDailyStats({
    startedAtMs,
    accountId: "acct-b",
    costUnits: 8.0,
    tokensTotal: 800,
    hasError: false,
  })

  const rows = db
    .query("SELECT account_id FROM daily_premium_stats ORDER BY account_id")
    .all() as Array<{ account_id: string }>

  expect(rows.length).toBe(2)
  expect(rows[0].account_id).toBe("acct-a")
  expect(rows[1].account_id).toBe("acct-b")
})

test("getDailyPremiumStats returns aggregated daily totals", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const day1 = new Date("2026-04-10T10:00:00").getTime()
  const day2 = new Date("2026-04-11T10:00:00").getTime()

  store.upsertDailyStats({
    startedAtMs: day1,
    accountId: "acct-a",
    costUnits: 10.0,
    tokensTotal: 1000,
    hasError: false,
  })
  store.upsertDailyStats({
    startedAtMs: day1,
    accountId: "acct-b",
    costUnits: 5.0,
    tokensTotal: 500,
    hasError: true,
  })
  store.upsertDailyStats({
    startedAtMs: day2,
    accountId: "acct-a",
    costUnits: 8.0,
    tokensTotal: 800,
    hasError: false,
  })

  const result = store.getDailyPremiumStats({
    from: "2026-04-10",
    to: "2026-04-11",
  })

  expect(result.daily.length).toBe(2)
  expect(result.daily[0].date).toBe("2026-04-10")
  expect(result.daily[0].request_count).toBe(2)
  expect(result.daily[0].cost_units_sum).toBe(15.0)
  expect(result.daily[0].tokens_total).toBe(1500)
  expect(result.daily[0].error_count).toBe(1)

  expect(result.daily[1].date).toBe("2026-04-11")
  expect(result.daily[1].request_count).toBe(1)

  expect(result.byAccount.length).toBe(3)
})

test("getDailyPremiumStats filters by account_id", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const day1 = new Date("2026-04-10T10:00:00").getTime()

  store.upsertDailyStats({
    startedAtMs: day1,
    accountId: "acct-a",
    costUnits: 10.0,
    tokensTotal: 1000,
    hasError: false,
  })
  store.upsertDailyStats({
    startedAtMs: day1,
    accountId: "acct-b",
    costUnits: 5.0,
    tokensTotal: 500,
    hasError: false,
  })

  const result = store.getDailyPremiumStats({
    from: "2026-04-10",
    to: "2026-04-10",
    accountId: "acct-a",
  })

  expect(result.daily.length).toBe(1)
  expect(result.daily[0].request_count).toBe(1)
  expect(result.daily[0].cost_units_sum).toBe(10.0)

  expect(result.byAccount.length).toBe(1)
  expect(result.byAccount[0].account_id).toBe("acct-a")
})

test("getDailyPremiumStats returns empty arrays for no data", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const result = store.getDailyPremiumStats({
    from: "2026-04-10",
    to: "2026-04-10",
  })

  expect(result.daily).toEqual([])
  expect(result.byAccount).toEqual([])
})

test("getHourlyPremiumStats aggregates by hour from request_log", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Insert directly into request_log for hourly queries
  const hour1 = new Date("2026-04-10T10:15:00").getTime()
  const hour1b = new Date("2026-04-10T10:45:00").getTime()
  const hour2 = new Date("2026-04-10T11:30:00").getTime()

  db.run(
    `INSERT INTO request_log
       (request_id, started_at_ms, method, path, account_id, cost_units, tokens_total, error_name)
     VALUES
       ('h-1', ?, 'POST', '/v1/messages', 'acct-a', 10.0, 1000, NULL),
       ('h-2', ?, 'POST', '/v1/messages', 'acct-a', 5.0,  500,  'Error'),
       ('h-3', ?, 'POST', '/v1/messages', 'acct-b', 8.0,  800,  NULL)`,
    [hour1, hour1b, hour2],
  )

  const result = store.getHourlyPremiumStats({
    fromMs: hour1,
    toMs: hour2 + 1000,
  })

  expect(result.daily.length).toBe(2)
  // First hour should have 2 requests aggregated
  expect(result.daily[0].request_count).toBe(2)
  expect(result.daily[0].cost_units_sum).toBe(15.0)
  // Second hour should have 1 request
  expect(result.daily[1].request_count).toBe(1)

  expect(result.byAccount.length).toBe(2)
})

test("cleanupStatsRetention removes old stats", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Insert a row with an old date
  const oldDate = new Date("2025-01-01T10:00:00").getTime()
  const recentDate = new Date("2026-04-10T10:00:00").getTime()

  store.upsertDailyStats({
    startedAtMs: oldDate,
    accountId: "acct-a",
    costUnits: 10.0,
    tokensTotal: 1000,
    hasError: false,
  })
  store.upsertDailyStats({
    startedAtMs: recentDate,
    accountId: "acct-a",
    costUnits: 5.0,
    tokensTotal: 500,
    hasError: false,
  })

  const beforeCount = (
    db.query("SELECT COUNT(*) as cnt FROM daily_premium_stats").get() as {
      cnt: number
    }
  ).cnt
  expect(beforeCount).toBe(2)

  // Cleanup with 30 days retention (old row should be removed)
  store.cleanupStatsRetention(30)

  const afterCount = (
    db.query("SELECT COUNT(*) as cnt FROM daily_premium_stats").get() as {
      cnt: number
    }
  ).cnt
  expect(afterCount).toBe(1)

  // Verify the remaining row is the recent one
  const remaining = db.query("SELECT date FROM daily_premium_stats").get() as {
    date: string
  }
  expect(remaining.date).toBe(toLocalDateString(recentDate))
})

test("toLocalDateString formats correctly", () => {
  // Use a known date in local time
  const ms = new Date(2026, 3, 10).getTime() // April 10, 2026 (month is 0-indexed)
  expect(toLocalDateString(ms)).toBe("2026-04-10")

  const ms2 = new Date(2026, 0, 1).getTime() // January 1, 2026
  expect(toLocalDateString(ms2)).toBe("2026-01-01")
})
