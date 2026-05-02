import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { getAdminDbUserVersion, initAdminDb } from "../src/lib/admin-db"
import { StatsStore, toLocalDateString } from "../src/lib/stats-store"

test("initAdminDb migrates admin DB to user_version 13", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(13)
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

test("quota_snapshots table has the expected columns", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const columns = db
    .query("PRAGMA table_info(quota_snapshots);")
    .all() as Array<{ name: string }>

  expect(columns.map((c) => c.name)).toEqual([
    "id",
    "account_id",
    "snapshot_at_ms",
    "remaining",
    "entitlement",
    "unlimited",
    "source",
  ])
})

test("insertQuotaSnapshot inserts a row into quota_snapshots", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: Date.now(),
    remaining: 280,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })

  const rows = db
    .query(
      "SELECT account_id, remaining, entitlement, unlimited, source FROM quota_snapshots",
    )
    .all() as Array<{
    account_id: string
    remaining: number
    entitlement: number
    unlimited: number
    source: string
  }>

  expect(rows.length).toBe(1)
  expect(rows[0].account_id).toBe("acct-a")
  expect(rows[0].remaining).toBe(280)
  expect(rows[0].entitlement).toBe(300)
  expect(rows[0].unlimited).toBe(0)
  expect(rows[0].source).toBe("refresh")
})

test("getConsumptionFromSnapshots computes daily consumption from remaining deltas", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Use hours that fall on the same calendar date in both UTC and UTC+8
  // (bun test runs JS in UTC, SQLite 'localtime' uses system TZ)
  // Day 1: remaining goes 300 → 290 → 280 (consumed 20)
  const day1_t1 = new Date(2026, 3, 10, 2, 0, 0).getTime()
  const day1_t2 = new Date(2026, 3, 10, 6, 0, 0).getTime()
  const day1_t3 = new Date(2026, 3, 10, 10, 0, 0).getTime()

  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: day1_t1,
    remaining: 300,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: day1_t2,
    remaining: 290,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: day1_t3,
    remaining: 280,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })

  // Day 2: remaining goes 280 → 270 (consumed 10)
  const day2_t1 = new Date(2026, 3, 11, 2, 0, 0).getTime()
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: day2_t1,
    remaining: 270,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })

  const fromMs = new Date(2026, 3, 10, 0, 0, 0).getTime()
  const toMs = new Date(2026, 3, 11, 23, 59, 59, 999).getTime()

  const result = store.getConsumptionFromSnapshots({
    fromMs,
    toMs,
    granularity: "day",
  })

  const day1 = result.find(
    (r) => r.date.includes("04-10") && r.account_id === "acct-a",
  )
  expect(day1?.premium_consumed).toBe(20)

  const day2 = result.find(
    (r) => r.date.includes("04-11") && r.account_id === "acct-a",
  )
  expect(day2?.premium_consumed).toBe(10)
})

test("getConsumptionFromSnapshots handles quota reset (remaining increases)", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // remaining: 50 → 20 (consumed 30), then reset → 300 → 290 (consumed 10)
  const t1 = new Date(2026, 3, 10, 8, 0, 0).getTime()
  const t2 = new Date(2026, 3, 10, 10, 0, 0).getTime()
  const t3 = new Date(2026, 3, 10, 12, 0, 0).getTime() // reset
  const t4 = new Date(2026, 3, 10, 14, 0, 0).getTime()

  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: t1,
    remaining: 50,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: t2,
    remaining: 20,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: t3,
    remaining: 300,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: t4,
    remaining: 290,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })

  const result = store.getConsumptionFromSnapshots({
    fromMs: t1,
    toMs: t4 + 1,
    granularity: "day",
  })

  const day = result.find((r) => r.account_id === "acct-a")
  // 30 (50→20) + 0 (reset 20→300) + 10 (300→290) = 40
  expect(day?.premium_consumed).toBe(40)
})

test("getConsumptionFromSnapshots excludes unlimited accounts", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const t1 = new Date(2026, 3, 10, 8, 0, 0).getTime()
  const t2 = new Date(2026, 3, 10, 12, 0, 0).getTime()

  store.insertQuotaSnapshot({
    accountId: "acct-unlimited",
    snapshotAtMs: t1,
    remaining: 999,
    entitlement: 999,
    unlimited: true,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-unlimited",
    snapshotAtMs: t2,
    remaining: 990,
    entitlement: 999,
    unlimited: true,
    source: "refresh",
  })

  const result = store.getConsumptionFromSnapshots({
    fromMs: t1,
    toMs: t2 + 1,
    granularity: "day",
  })

  expect(result.length).toBe(0)
})

test("getConsumptionFromSnapshots uses baseline snapshot before range", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Baseline: before range
  const baseline = new Date(2026, 3, 9, 23, 0, 0).getTime()
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: baseline,
    remaining: 300,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })

  // In range: remaining drops
  const t1 = new Date(2026, 3, 10, 8, 0, 0).getTime()
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: t1,
    remaining: 290,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })

  const fromMs = new Date(2026, 3, 10, 0, 0, 0).getTime()
  const toMs = new Date(2026, 3, 10, 23, 59, 59, 999).getTime()

  const result = store.getConsumptionFromSnapshots({
    fromMs,
    toMs,
    granularity: "day",
  })

  const day = result.find((r) => r.account_id === "acct-a")
  // Baseline 300 → 290 = consumed 10
  expect(day?.premium_consumed).toBe(10)
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

  expect(getAdminDbUserVersion(db)).toBe(13)

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

test("v10 migration backfills quota_snapshots from request_log", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  db.run("PRAGMA user_version = 9;")
  db.run("DROP TABLE IF EXISTS quota_snapshots;")

  const baseMs = new Date("2026-04-10T12:00:00").getTime()
  db.run(
    `INSERT INTO request_log
       (request_id, started_at_ms, finished_at_ms, method, path, account_id,
        cost_units, premium_remaining_after, premium_unlimited_after)
     VALUES
       ('qs-1', ?, ?, 'POST', '/v1/messages', 'acct-a', 10.0, 290, 0),
       ('qs-2', ?, ?, 'POST', '/v1/messages', 'acct-a', 5.0, 285, NULL),
       ('qs-3', ?, ?, 'POST', '/v1/messages', 'acct-b', 8.0, 192, 1)`,
    [
      baseMs,
      baseMs + 100,
      baseMs + 1000,
      baseMs + 1100,
      baseMs + 2000,
      baseMs + 2100,
    ],
  )

  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(13)

  const rows = db
    .query(
      "SELECT account_id, snapshot_at_ms, remaining, entitlement, unlimited, source FROM quota_snapshots ORDER BY snapshot_at_ms",
    )
    .all() as Array<{
    account_id: string
    snapshot_at_ms: number
    remaining: number
    entitlement: number
    unlimited: number
    source: string
  }>

  expect(rows).toEqual([
    {
      account_id: "acct-a",
      snapshot_at_ms: baseMs + 100,
      remaining: 290,
      entitlement: 0,
      unlimited: 0,
      source: "backfill",
    },
    {
      account_id: "acct-a",
      snapshot_at_ms: baseMs + 1100,
      remaining: 285,
      entitlement: 0,
      unlimited: 0,
      source: "backfill",
    },
    {
      account_id: "acct-b",
      snapshot_at_ms: baseMs + 2100,
      remaining: 192,
      entitlement: 0,
      unlimited: 1,
      source: "backfill",
    },
  ])
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
  expect(result.daily[0].premium_consumed).toBe(0) // No snapshots inserted
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
  expect(result.daily[0].premium_consumed).toBe(0) // No snapshots inserted

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
  expect(result.daily[0].premium_consumed).toBe(0) // No snapshots inserted
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

test("cleanupStatsRetention preserves baseline snapshot per account", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Very old snapshot (should be deleted)
  const veryOld = new Date("2024-01-01T10:00:00").getTime()
  // Old snapshot but latest before cutoff (should be PRESERVED as baseline)
  const oldLatest = new Date("2025-01-01T10:00:00").getTime()
  // Recent snapshot (should be preserved)
  const recent = new Date("2026-04-10T10:00:00").getTime()

  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: veryOld,
    remaining: 300,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: oldLatest,
    remaining: 250,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: recent,
    remaining: 200,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })

  const beforeCount = (
    db.query("SELECT COUNT(*) as cnt FROM quota_snapshots").get() as {
      cnt: number
    }
  ).cnt
  expect(beforeCount).toBe(3)

  // 30 days retention — veryOld and oldLatest are both before cutoff
  store.cleanupStatsRetention(30)

  const afterRows = db
    .query(
      "SELECT account_id, snapshot_at_ms, remaining FROM quota_snapshots ORDER BY snapshot_at_ms",
    )
    .all() as Array<{
    account_id: string
    snapshot_at_ms: number
    remaining: number
  }>

  // veryOld deleted, oldLatest preserved as baseline, recent preserved
  expect(afterRows.length).toBe(2)
  expect(afterRows[0].snapshot_at_ms).toBe(oldLatest)
  expect(afterRows[0].remaining).toBe(250)
  expect(afterRows[1].snapshot_at_ms).toBe(recent)
})

test("toLocalDateString formats correctly", () => {
  // Use a known date in local time
  const ms = new Date(2026, 3, 10).getTime() // April 10, 2026 (month is 0-indexed)
  expect(toLocalDateString(ms)).toBe("2026-04-10")

  const ms2 = new Date(2026, 0, 1).getTime() // January 1, 2026
  expect(toLocalDateString(ms2)).toBe("2026-01-01")
})

test("getHourlyPremiumStats returns UTC ISO hour bucket format", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Use explicit UTC hours so the expected bucket is timezone-independent
  const t1 = Date.UTC(2026, 3, 10, 14, 30, 0)

  db.run(
    `INSERT INTO request_log
       (request_id, started_at_ms, method, path, account_id, cost_units, tokens_total, error_name)
     VALUES ('utc-1', ?, 'POST', '/v1/messages', 'acct-a', 10.0, 1000, NULL)`,
    [t1],
  )

  const result = store.getHourlyPremiumStats({
    fromMs: t1 - 1000,
    toMs: t1 + 1000,
  })

  expect(result.daily.length).toBe(1)
  expect(result.daily[0].date).toBe("2026-04-10T14:00:00Z")
})

test("getConsumptionFromSnapshots hourly uses UTC ISO hour bucket format", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const t1 = Date.UTC(2026, 3, 10, 14, 0, 0)
  const t2 = Date.UTC(2026, 3, 10, 14, 30, 0)

  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: t1,
    remaining: 300,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })
  store.insertQuotaSnapshot({
    accountId: "acct-a",
    snapshotAtMs: t2,
    remaining: 290,
    entitlement: 300,
    unlimited: false,
    source: "refresh",
  })

  const result = store.getConsumptionFromSnapshots({
    fromMs: t1,
    toMs: t2 + 1,
    granularity: "hour",
  })

  expect(result.length).toBe(1)
  expect(result[0].date).toBe("2026-04-10T14:00:00Z")
  expect(result[0].premium_consumed).toBe(10)
})
