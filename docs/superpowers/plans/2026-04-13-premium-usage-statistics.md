# Premium Usage Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Statistics page to the admin UI with two Recharts charts showing daily premium request usage (total and per-account), backed by a dedicated `daily_premium_stats` table with write-time aggregation.

**Architecture:** Write-time upsert into `daily_premium_stats` on each premium request. Dedicated `StatsStore` class handles all stats DB operations. A single API endpoint (`GET /api/admin/stats/premium-daily`) serves both day-granularity (from stats table) and hour-granularity (from `request_log`). Frontend uses Recharts with shadcn CSS chart variables.

**Tech Stack:** Bun SQLite, Hono, Recharts, React 19, Tailwind CSS 4, shadcn/ui patterns, i18next

**Design Spec:** `docs/superpowers/specs/2026-04-13-premium-usage-statistics-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/lib/stats-store.ts` | `StatsStore` class: daily premium stats upsert, day/hour queries, retention cleanup |
| `tests/stats-store.test.ts` | Unit tests for StatsStore and v9 migration |
| `admin-ui/src/pages/statistics-page.tsx` | Statistics page with time controls, data loading, chart layout |
| `admin-ui/src/components/charts/premium-usage-chart.tsx` | Total usage ComposedChart (cost_units area + request_count line) |
| `admin-ui/src/components/charts/account-usage-chart.tsx` | Per-account stacked AreaChart |

### Modified Files

| File | Changes |
|------|---------|
| `src/lib/admin-db.ts` | Add `migrateV9()` (create table + backfill), bump guard to `>= 9` |
| `src/lib/request-history.ts` | Call `statsStore.upsertDailyStats()` from `insert()` when `costUnits > 0` |
| `src/routes/admin-api/route.ts` | Add `GET /stats/premium-daily` handler |
| `admin-ui/package.json` | Add `recharts` dependency |
| `admin-ui/src/App.tsx` | Add `/statistics` route |
| `admin-ui/src/components/app-shell.tsx` | Add Statistics nav item |
| `admin-ui/src/lib/admin-api.ts` | Add types + `getAdminPremiumStats()` |
| `admin-ui/src/locales/en-US.json` | Add statistics i18n keys |
| `admin-ui/src/locales/zh-CN.json` | Add statistics i18n keys |

---

### Task 1: DB Migration v9 — Create `daily_premium_stats` Table

**Files:**
- Modify: `src/lib/admin-db.ts:151-273`

- [ ] **Step 1: Add `migrateV9()` function**

In `src/lib/admin-db.ts`, add a new function after `migrateV8()` (after line 168):

```typescript
function migrateV9(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_premium_stats (
      date            TEXT    NOT NULL,
      account_id      TEXT    NOT NULL,
      request_count   INTEGER NOT NULL DEFAULT 0,
      cost_units_sum  REAL    NOT NULL DEFAULT 0,
      tokens_total    INTEGER NOT NULL DEFAULT 0,
      error_count     INTEGER NOT NULL DEFAULT 0,
      updated_at_ms   INTEGER NOT NULL,
      PRIMARY KEY (date, account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_premium_stats_date
      ON daily_premium_stats(date);
  `)

  // Backfill from existing request_log
  const nowMs = Date.now()
  db.run(
    `INSERT INTO daily_premium_stats
       (date, account_id, request_count, cost_units_sum, tokens_total, error_count, updated_at_ms)
     SELECT
       date(started_at_ms / 1000, 'unixepoch', 'localtime') AS date,
       account_id,
       COUNT(*)                                              AS request_count,
       SUM(cost_units)                                       AS cost_units_sum,
       COALESCE(SUM(tokens_total), 0)                        AS tokens_total,
       SUM(CASE WHEN error_name IS NOT NULL THEN 1 ELSE 0 END) AS error_count,
       ?                                                     AS updated_at_ms
     FROM request_log
     WHERE cost_units > 0
       AND account_id IS NOT NULL
     GROUP BY 1, 2
     ON CONFLICT(date, account_id) DO UPDATE SET
       request_count   = excluded.request_count,
       cost_units_sum  = excluded.cost_units_sum,
       tokens_total    = excluded.tokens_total,
       error_count     = excluded.error_count,
       updated_at_ms   = excluded.updated_at_ms;`,
    [nowMs],
  )

  db.run("PRAGMA user_version = 9;")
}
```

- [ ] **Step 2: Update migration guard and call chain**

In `migrateAdminDb()`, change the guard from `>= 8` to `>= 9` and add the v9 call:

```typescript
// Line 177: change guard
if (current >= 9) {
  return
}
```

At the end of `migrateAdminDb()` (after the `migrateV8(db)` call at line 273), add:

```typescript
  migrateV8(db)
  migrateV9(db)
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no type errors)

---

### Task 2: StatsStore — Data Layer

**Files:**
- Create: `src/lib/stats-store.ts`
- Create: `tests/stats-store.test.ts`

- [ ] **Step 1: Write tests for StatsStore**

Create `tests/stats-store.test.ts`:

```typescript
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { getAdminDbUserVersion, initAdminDb } from "../src/lib/admin-db"
import { StatsStore } from "../src/lib/stats-store"

// --- Migration tests ---

test("initAdminDb migrates to user_version 9", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  expect(getAdminDbUserVersion(db)).toBe(9)
})

test("initAdminDb creates daily_premium_stats table with expected columns", () => {
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

  // First, run full migration to create all tables (v1-v9)
  initAdminDb(db)
  expect(getAdminDbUserVersion(db)).toBe(9)

  // Simulate a v8 DB: reset version and drop the stats table
  db.run("PRAGMA user_version = 8;")
  db.run("DROP TABLE IF EXISTS daily_premium_stats;")

  // Insert premium request_log entries (table exists from v1 migration)
  const now = Date.now()
  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream, account_id, cost_units, tokens_total, error_name)
     VALUES ('req1', ?, 'POST', '/v1/messages', 0, 'alice', 50, 1000, NULL)`,
    [now],
  )
  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream, account_id, cost_units, tokens_total, error_name)
     VALUES ('req2', ?, 'POST', '/v1/messages', 0, 'alice', 1, 500, NULL)`,
    [now],
  )
  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream, account_id, cost_units, tokens_total, error_name)
     VALUES ('req3', ?, 'POST', '/v1/messages', 0, 'bob', 50, 2000, 'SomeError')`,
    [now],
  )

  // Re-run initAdminDb — should detect v8, run v9 migration with backfill
  initAdminDb(db)
  expect(getAdminDbUserVersion(db)).toBe(9)

  // Verify backfilled stats
  const stats = db
    .query("SELECT account_id, request_count, cost_units_sum, tokens_total, error_count FROM daily_premium_stats ORDER BY account_id")
    .all() as Array<{ account_id: string; request_count: number; cost_units_sum: number; tokens_total: number; error_count: number }>

  expect(stats).toHaveLength(2)
  expect(stats[0]).toMatchObject({
    account_id: "alice",
    request_count: 2,
    cost_units_sum: 51,
    tokens_total: 1500,
    error_count: 0,
  })
  expect(stats[1]).toMatchObject({
    account_id: "bob",
    request_count: 1,
    cost_units_sum: 50,
    tokens_total: 2000,
    error_count: 1,
  })
})

// --- StatsStore upsert tests ---

test("upsertDailyStats creates a new row for a new date+account", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  store.upsertDailyStats({
    startedAtMs: new Date("2026-04-13T10:00:00").getTime(),
    accountId: "alice",
    costUnits: 50,
    tokensTotal: 1000,
    hasError: false,
  })

  const rows = db
    .query("SELECT * FROM daily_premium_stats")
    .all() as Array<Record<string, unknown>>

  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    date: "2026-04-13",
    account_id: "alice",
    request_count: 1,
    cost_units_sum: 50,
    tokens_total: 1000,
    error_count: 0,
  })
})

test("upsertDailyStats accumulates on same date+account", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const baseMs = new Date("2026-04-13T10:00:00").getTime()

  store.upsertDailyStats({
    startedAtMs: baseMs,
    accountId: "alice",
    costUnits: 50,
    tokensTotal: 1000,
    hasError: false,
  })
  store.upsertDailyStats({
    startedAtMs: baseMs + 3600_000,
    accountId: "alice",
    costUnits: 1,
    tokensTotal: 500,
    hasError: true,
  })

  const rows = db
    .query("SELECT * FROM daily_premium_stats")
    .all() as Array<Record<string, unknown>>

  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    request_count: 2,
    cost_units_sum: 51,
    tokens_total: 1500,
    error_count: 1,
  })
})

test("upsertDailyStats creates separate rows for different accounts", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const baseMs = new Date("2026-04-13T10:00:00").getTime()

  store.upsertDailyStats({
    startedAtMs: baseMs,
    accountId: "alice",
    costUnits: 50,
    tokensTotal: 1000,
    hasError: false,
  })
  store.upsertDailyStats({
    startedAtMs: baseMs,
    accountId: "bob",
    costUnits: 1,
    tokensTotal: 200,
    hasError: false,
  })

  const rows = db
    .query("SELECT * FROM daily_premium_stats ORDER BY account_id")
    .all() as Array<Record<string, unknown>>

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ account_id: "alice", request_count: 1 })
  expect(rows[1]).toMatchObject({ account_id: "bob", request_count: 1 })
})

// --- StatsStore query tests ---

test("getDailyPremiumStats returns aggregated daily totals", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const day1 = new Date("2026-04-12T10:00:00").getTime()
  const day2 = new Date("2026-04-13T10:00:00").getTime()

  store.upsertDailyStats({ startedAtMs: day1, accountId: "alice", costUnits: 50, tokensTotal: 1000, hasError: false })
  store.upsertDailyStats({ startedAtMs: day1, accountId: "bob", costUnits: 1, tokensTotal: 200, hasError: false })
  store.upsertDailyStats({ startedAtMs: day2, accountId: "alice", costUnits: 50, tokensTotal: 800, hasError: true })

  const result = store.getDailyPremiumStats({ from: "2026-04-12", to: "2026-04-13" })

  expect(result.daily).toHaveLength(2)
  expect(result.daily[0]).toMatchObject({
    date: "2026-04-12",
    request_count: 2,
    cost_units_sum: 51,
  })
  expect(result.daily[1]).toMatchObject({
    date: "2026-04-13",
    request_count: 1,
    cost_units_sum: 50,
  })

  expect(result.byAccount).toHaveLength(3)
})

test("getDailyPremiumStats filters by account_id", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const day1 = new Date("2026-04-12T10:00:00").getTime()

  store.upsertDailyStats({ startedAtMs: day1, accountId: "alice", costUnits: 50, tokensTotal: 1000, hasError: false })
  store.upsertDailyStats({ startedAtMs: day1, accountId: "bob", costUnits: 1, tokensTotal: 200, hasError: false })

  const result = store.getDailyPremiumStats({ from: "2026-04-12", to: "2026-04-12", accountId: "alice" })

  expect(result.daily).toHaveLength(1)
  expect(result.daily[0]).toMatchObject({ cost_units_sum: 50 })
  expect(result.byAccount).toHaveLength(1)
  expect(result.byAccount[0]).toMatchObject({ account_id: "alice" })
})

test("getDailyPremiumStats returns empty arrays for no data in range", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const result = store.getDailyPremiumStats({ from: "2026-04-01", to: "2026-04-30" })

  expect(result.daily).toEqual([])
  expect(result.byAccount).toEqual([])
})

// --- Hourly query tests ---

test("getHourlyPremiumStats aggregates by hour from request_log", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Insert directly into request_log for hourly test
  const hour1 = new Date("2026-04-13T10:30:00").getTime()
  const hour2 = new Date("2026-04-13T11:15:00").getTime()

  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream, account_id, cost_units, tokens_total)
     VALUES ('h1', ?, 'POST', '/v1/messages', 0, 'alice', 50, 1000)`,
    [hour1],
  )
  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream, account_id, cost_units, tokens_total)
     VALUES ('h2', ?, 'POST', '/v1/messages', 0, 'alice', 1, 500)`,
    [hour2],
  )

  const fromMs = new Date("2026-04-13T00:00:00").getTime()
  const toMs = new Date("2026-04-13T23:59:59").getTime()

  const result = store.getHourlyPremiumStats({ fromMs, toMs })

  expect(result.daily.length).toBeGreaterThanOrEqual(2)
  expect(result.byAccount.length).toBeGreaterThanOrEqual(2)
})

// --- Cleanup tests ---

test("cleanupStatsRetention removes old stats", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Insert a very old stat
  db.run(
    `INSERT INTO daily_premium_stats (date, account_id, request_count, cost_units_sum, tokens_total, error_count, updated_at_ms)
     VALUES ('2020-01-01', 'old-account', 1, 50, 1000, 0, 0)`,
  )
  // Insert a recent stat
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
  db.run(
    `INSERT INTO daily_premium_stats (date, account_id, request_count, cost_units_sum, tokens_total, error_count, updated_at_ms)
     VALUES (?, 'recent-account', 1, 50, 1000, 0, 0)`,
    [todayStr],
  )

  store.cleanupStatsRetention(180)

  const rows = db
    .query("SELECT account_id FROM daily_premium_stats")
    .all() as Array<{ account_id: string }>

  expect(rows).toHaveLength(1)
  expect(rows[0]?.account_id).toBe("recent-account")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/stats-store.test.ts`
Expected: FAIL — `StatsStore` not found, migration still at v8

- [ ] **Step 3: Create `src/lib/stats-store.ts`**

```typescript
import type { Database } from "bun:sqlite"

import { consola } from "consola"

export interface DailyStats {
  date: string
  request_count: number
  cost_units_sum: number
  tokens_total: number
  error_count: number
}

export interface DailyAccountStats extends DailyStats {
  account_id: string
}

export interface PremiumStatsResponse {
  daily: DailyStats[]
  by_account: DailyAccountStats[]
  range: { from: string; to: string; granularity: "day" | "hour" }
}

export const DEFAULT_STATS_RETENTION_DAYS = 180

export function toLocalDateString(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export class StatsStore {
  private readonly db: Database
  private readonly upsertStmt: ReturnType<Database["query"]>

  constructor(db: Database) {
    this.db = db
    this.upsertStmt = db.query(`
      INSERT INTO daily_premium_stats
        (date, account_id, request_count, cost_units_sum, tokens_total, error_count, updated_at_ms)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(date, account_id) DO UPDATE SET
        request_count   = request_count  + 1,
        cost_units_sum  = cost_units_sum + excluded.cost_units_sum,
        tokens_total    = tokens_total   + excluded.tokens_total,
        error_count     = error_count    + excluded.error_count,
        updated_at_ms   = excluded.updated_at_ms
    `)
  }

  upsertDailyStats(record: {
    startedAtMs: number
    accountId: string
    costUnits: number
    tokensTotal: number
    hasError: boolean
  }): void {
    const date = toLocalDateString(record.startedAtMs)
    this.upsertStmt.run(
      date,
      record.accountId,
      record.costUnits,
      record.tokensTotal ?? 0,
      record.hasError ? 1 : 0,
      Date.now(),
    )
  }

  getDailyPremiumStats(params: {
    from: string
    to: string
    accountId?: string
  }): { daily: DailyStats[]; byAccount: DailyAccountStats[] } {
    const accountFilter = params.accountId ? " AND account_id = ?" : ""
    const args: (string | number)[] = [params.from, params.to]
    if (params.accountId) args.push(params.accountId)

    const daily = this.db
      .query(
        `SELECT date,
                SUM(request_count)  AS request_count,
                SUM(cost_units_sum) AS cost_units_sum,
                SUM(tokens_total)   AS tokens_total,
                SUM(error_count)    AS error_count
         FROM daily_premium_stats
         WHERE date >= ? AND date <= ?${accountFilter}
         GROUP BY date
         ORDER BY date`,
      )
      .all(...args) as DailyStats[]

    const byAccount = this.db
      .query(
        `SELECT date, account_id, request_count, cost_units_sum, tokens_total, error_count
         FROM daily_premium_stats
         WHERE date >= ? AND date <= ?${accountFilter}
         ORDER BY date, account_id`,
      )
      .all(...args) as DailyAccountStats[]

    return { daily, byAccount }
  }

  getHourlyPremiumStats(params: {
    fromMs: number
    toMs: number
    accountId?: string
  }): { daily: DailyStats[]; byAccount: DailyAccountStats[] } {
    const accountFilter = params.accountId ? " AND account_id = ?" : ""
    const dailyArgs: (string | number)[] = [params.fromMs, params.toMs]
    if (params.accountId) dailyArgs.push(params.accountId)

    const daily = this.db
      .query(
        `SELECT strftime('%Y-%m-%d %H:00', started_at_ms / 1000, 'unixepoch', 'localtime') AS date,
                COUNT(*)                                                   AS request_count,
                SUM(cost_units)                                            AS cost_units_sum,
                COALESCE(SUM(tokens_total), 0)                             AS tokens_total,
                SUM(CASE WHEN error_name IS NOT NULL THEN 1 ELSE 0 END)    AS error_count
         FROM request_log
         WHERE cost_units > 0
           AND started_at_ms >= ? AND started_at_ms <= ?${accountFilter}
         GROUP BY 1
         ORDER BY 1`,
      )
      .all(...dailyArgs) as DailyStats[]

    const byAccountFilter = params.accountId
      ? " AND account_id = ?"
      : " AND account_id IS NOT NULL"
    const byAccountArgs: (string | number)[] = [params.fromMs, params.toMs]
    if (params.accountId) byAccountArgs.push(params.accountId)

    const byAccount = this.db
      .query(
        `SELECT strftime('%Y-%m-%d %H:00', started_at_ms / 1000, 'unixepoch', 'localtime') AS date,
                account_id,
                COUNT(*)                                                   AS request_count,
                SUM(cost_units)                                            AS cost_units_sum,
                COALESCE(SUM(tokens_total), 0)                             AS tokens_total,
                SUM(CASE WHEN error_name IS NOT NULL THEN 1 ELSE 0 END)    AS error_count
         FROM request_log
         WHERE cost_units > 0${byAccountFilter}
           AND started_at_ms >= ? AND started_at_ms <= ?
         GROUP BY 1, 2
         ORDER BY 1, 2`,
      )
      .all(...byAccountArgs) as DailyAccountStats[]

    return { daily, byAccount }
  }

  cleanupStatsRetention(
    retentionDays: number = DEFAULT_STATS_RETENTION_DAYS,
  ): void {
    try {
      const cutoffDate = toLocalDateString(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      )
      this.db
        .query("DELETE FROM daily_premium_stats WHERE date < ?;")
        .run(cutoffDate)
    } catch (error) {
      consola.debug("Failed to cleanup daily_premium_stats retention", error)
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/stats-store.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Also run the existing session-affinity-store tests to check no regression**

Run: `bun test tests/session-affinity-store.test.ts`
Expected: The `user_version` test needs updating — it will now expect 9 instead of 8. Update the assertion in `tests/session-affinity-store.test.ts`:

Change line 11:
```typescript
expect(getAdminDbUserVersion(db)).toBe(9)
```
Change line 35:
```typescript
expect(getAdminDbUserVersion(db)).toBe(9)
```

Run again: `bun test tests/session-affinity-store.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite to check no regression**

Run: `bun test`
Expected: ALL PASS (fix any other tests that assert `user_version = 8`)

- [ ] **Step 7: Commit**

```bash
git add src/lib/stats-store.ts src/lib/admin-db.ts tests/stats-store.test.ts tests/session-affinity-store.test.ts
git commit -m "feat: add daily_premium_stats table with write-time aggregation (v9 migration)"
```

---

### Task 3: Hook StatsStore into Request History Insert

**Files:**
- Modify: `src/lib/request-history.ts:406-462`

- [ ] **Step 1: Add StatsStore import and singleton**

At the top of `src/lib/request-history.ts`, add import:

```typescript
import { StatsStore } from "~/lib/stats-store"
```

Add a lazy singleton for StatsStore after the `sharedStore` variable (around line 750):

```typescript
let sharedStatsStore: StatsStore | null = null

function getStatsStoreInstance(): StatsStore | null {
  if (sharedStatsStore) return sharedStatsStore
  try {
    sharedStatsStore = new StatsStore(getAdminDb())
    return sharedStatsStore
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Call upsert in `insert()` method**

In the `insert()` method, after `this.insertStmt.run(...args)` (line 462), add:

```typescript
    this.insertStmt.run(...args)

    // Write-time aggregation for premium stats
    if (
      record.costUnits != null &&
      record.costUnits > 0 &&
      record.accountId
    ) {
      try {
        getStatsStoreInstance()?.upsertDailyStats({
          startedAtMs: record.startedAtMs,
          accountId: record.accountId,
          costUnits: record.costUnits,
          tokensTotal: record.tokensTotal ?? 0,
          hasError: record.errorName != null,
        })
      } catch {
        // Stats aggregation is best-effort; never break request logging
      }
    }
```

- [ ] **Step 3: Add stats cleanup to maintenance loop**

In `getRequestHistoryStore()` (around line 770), after `sharedStore.cleanupRetention()`, add:

```typescript
      sharedStore.cleanupRetention()
      getStatsStoreInstance()?.cleanupStatsRetention()
```

And in the setInterval callback:

```typescript
      setInterval(
        () => {
          sharedStore?.cleanupRetention()
          try {
            getStatsStoreInstance()?.cleanupStatsRetention()
          } catch {
            // Best-effort
          }
        },
        24 * 60 * 60 * 1000,
      )
```

- [ ] **Step 4: Export getStatsStore for route handler use**

At the bottom of `request-history.ts`, add:

```typescript
export function getStatsStore(): StatsStore | null {
  return getStatsStoreInstance()
}
```

- [ ] **Step 5: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/request-history.ts
git commit -m "feat: hook stats upsert into request history insert for premium requests"
```

---

### Task 4: Admin API Endpoint

**Files:**
- Modify: `src/routes/admin-api/route.ts`

- [ ] **Step 1: Add the GET /stats/premium-daily endpoint**

In `src/routes/admin-api/route.ts`, after the last existing endpoint (around line 1610), add:

```typescript
adminApiRoutes.get("/stats/premium-daily", (c) => {
  const url = new URL(c.req.url, "http://local")
  const p = url.searchParams

  const from = p.get("from") || undefined
  const to = p.get("to") || undefined
  const accountId = p.get("account_id") || undefined
  const granularity = p.get("granularity") === "hour" ? "hour" : "day"

  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

  const resolvedFrom =
    from ||
    (() => {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    })()
  const resolvedTo = to || todayStr

  // Validate granularity=hour range <= 48h
  if (granularity === "hour") {
    const fromDate = new Date(resolvedFrom)
    const toDate = new Date(resolvedTo)
    const diffMs = toDate.getTime() - fromDate.getTime() + 24 * 60 * 60 * 1000
    if (diffMs > 48 * 60 * 60 * 1000) {
      return jsonError(c, 400, {
        message:
          "Hourly granularity is only supported for ranges up to 48 hours.",
        type: "bad_request",
      })
    }
  }

  const statsStore = getStatsStore()
  if (!statsStore) {
    return c.json({
      daily: [],
      by_account: [],
      range: { from: resolvedFrom, to: resolvedTo, granularity },
    })
  }

  if (granularity === "hour") {
    const fromMs = new Date(resolvedFrom).getTime()
    const toMs = new Date(resolvedTo + "T23:59:59.999").getTime()
    const result = statsStore.getHourlyPremiumStats({
      fromMs,
      toMs,
      accountId,
    })
    return c.json({
      daily: result.daily,
      by_account: result.byAccount,
      range: { from: resolvedFrom, to: resolvedTo, granularity },
    })
  }

  const result = statsStore.getDailyPremiumStats({
    from: resolvedFrom,
    to: resolvedTo,
    accountId,
  })
  return c.json({
    daily: result.daily,
    by_account: result.byAccount,
    range: { from: resolvedFrom, to: resolvedTo, granularity },
  })
})
```

- [ ] **Step 2: Add import for getStatsStore**

At the top of `route.ts`, add to imports from request-history:

```typescript
import { getRequestHistoryStore, getStatsStore } from "~/lib/request-history"
```

If `getRequestHistoryStore` is already imported, just add `getStatsStore` to the same import.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin-api/route.ts
git commit -m "feat: add GET /api/admin/stats/premium-daily endpoint"
```

---

### Task 5: Install Recharts

**Files:**
- Modify: `admin-ui/package.json`

- [ ] **Step 1: Install recharts in admin-ui**

Run from project root:
```bash
cd admin-ui && bun add recharts && cd ..
```

- [ ] **Step 2: Verify installation**

Run: `cd admin-ui && bun run build && cd ..`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add admin-ui/package.json admin-ui/bun.lock
git commit -m "chore: add recharts dependency to admin-ui"
```

---

### Task 6: Frontend API Client

**Files:**
- Modify: `admin-ui/src/lib/admin-api.ts`

- [ ] **Step 1: Add types for premium stats**

After the existing type definitions (around line 187), add:

```typescript
export type DailyStatsItem = {
  date: string
  request_count: number
  cost_units_sum: number
  tokens_total: number
  error_count: number
}

export type DailyAccountStatsItem = DailyStatsItem & {
  account_id: string
}

export type PremiumStatsResponse = {
  daily: DailyStatsItem[]
  by_account: DailyAccountStatsItem[]
  range: { from: string; to: string; granularity: "day" | "hour" }
}
```

- [ ] **Step 2: Add getAdminPremiumStats function**

After the existing `getAdmin*` functions (around line 333), add:

```typescript
export async function getAdminPremiumStats(params: {
  from?: string
  to?: string
  accountId?: string
  granularity?: "day" | "hour"
}): Promise<PremiumStatsResponse> {
  const q = new URLSearchParams()
  if (params.from) q.set("from", params.from)
  if (params.to) q.set("to", params.to)
  if (params.accountId) q.set("account_id", params.accountId)
  if (params.granularity) q.set("granularity", params.granularity)
  return fetchAdminJson<PremiumStatsResponse>(
    `/api/admin/stats/premium-daily?${q.toString()}`,
  )
}
```

- [ ] **Step 3: Run admin-ui typecheck**

Run: `cd admin-ui && npx tsc --noEmit && cd ..`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/lib/admin-api.ts
git commit -m "feat: add getAdminPremiumStats API client"
```

---

### Task 7: Chart Components

**Files:**
- Create: `admin-ui/src/components/charts/premium-usage-chart.tsx`
- Create: `admin-ui/src/components/charts/account-usage-chart.tsx`

- [ ] **Step 1: Create PremiumUsageChart**

Create `admin-ui/src/components/charts/premium-usage-chart.tsx`:

```tsx
import { useTranslation } from "react-i18next"
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { DailyStatsItem } from "@/lib/admin-api"

interface PremiumUsageChartProps {
  data: DailyStatsItem[]
  isHourly?: boolean
}

export function PremiumUsageChart({
  data,
  isHourly,
}: PremiumUsageChartProps): React.JSX.Element {
  const { t } = useTranslation()

  const formatXAxis = (value: string): string => {
    if (isHourly) {
      // 'YYYY-MM-DD HH:00' -> 'HH:00'
      return value.split(" ")[1] ?? value
    }
    // 'YYYY-MM-DD' -> 'MM-DD'
    return value.slice(5)
  }

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">
        {t("statistics.premiumUsage")}
      </h3>
      {data.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          {t("statistics.noData")}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date"
              tickFormatter={formatXAxis}
              className="text-xs"
              tick={{ fill: "var(--color-muted-foreground)" }}
            />
            <YAxis
              yAxisId="cost"
              tick={{ fill: "var(--color-muted-foreground)" }}
              className="text-xs"
              label={{
                value: t("statistics.costUnits"),
                angle: -90,
                position: "insideLeft",
                style: { fill: "var(--color-muted-foreground)", fontSize: 12 },
              }}
            />
            <YAxis
              yAxisId="count"
              orientation="right"
              tick={{ fill: "var(--color-muted-foreground)" }}
              className="text-xs"
              label={{
                value: t("statistics.requestCount"),
                angle: 90,
                position: "insideRight",
                style: { fill: "var(--color-muted-foreground)", fontSize: 12 },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              labelFormatter={(label) =>
                isHourly ? String(label) : String(label)
              }
            />
            <Area
              yAxisId="cost"
              type="monotone"
              dataKey="cost_units_sum"
              name={t("statistics.costUnits")}
              fill="var(--color-chart-1)"
              fillOpacity={0.2}
              stroke="var(--color-chart-1)"
              strokeWidth={2}
            />
            <Line
              yAxisId="count"
              type="monotone"
              dataKey="request_count"
              name={t("statistics.requestCount")}
              stroke="var(--color-chart-2)"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create AccountUsageChart**

Create `admin-ui/src/components/charts/account-usage-chart.tsx`:

```tsx
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { DailyAccountStatsItem } from "@/lib/admin-api"

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
]

interface AccountUsageChartProps {
  data: DailyAccountStatsItem[]
  isHourly?: boolean
}

export function AccountUsageChart({
  data,
  isHourly,
}: AccountUsageChartProps): React.JSX.Element {
  const { t } = useTranslation()

  const { pivotedData, accountIds } = useMemo(() => {
    const accounts = new Set<string>()
    const dateMap = new Map<string, Record<string, number>>()

    for (const item of data) {
      accounts.add(item.account_id)
      const existing = dateMap.get(item.date) ?? {}
      existing[item.account_id] = item.cost_units_sum
      dateMap.set(item.date, existing)
    }

    const sortedAccounts = [...accounts].sort()
    const pivoted = [...dateMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, values]) => ({
        date,
        ...Object.fromEntries(
          sortedAccounts.map((id) => [id, values[id] ?? 0]),
        ),
      }))

    return { pivotedData: pivoted, accountIds: sortedAccounts }
  }, [data])

  const formatXAxis = (value: string): string => {
    if (isHourly) {
      return value.split(" ")[1] ?? value
    }
    return value.slice(5)
  }

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">
        {t("statistics.accountUsage")}
      </h3>
      {pivotedData.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          {t("statistics.noData")}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={pivotedData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date"
              tickFormatter={formatXAxis}
              className="text-xs"
              tick={{ fill: "var(--color-muted-foreground)" }}
            />
            <YAxis
              tick={{ fill: "var(--color-muted-foreground)" }}
              className="text-xs"
              label={{
                value: t("statistics.costUnits"),
                angle: -90,
                position: "insideLeft",
                style: { fill: "var(--color-muted-foreground)", fontSize: 12 },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
            />
            <Legend />
            {accountIds.map((accountId, index) => (
              <Area
                key={accountId}
                type="monotone"
                dataKey={accountId}
                name={accountId}
                stackId="1"
                fill={CHART_COLORS[index % CHART_COLORS.length]}
                fillOpacity={0.3}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Run admin-ui typecheck**

Run: `cd admin-ui && npx tsc --noEmit && cd ..`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/components/charts/
git commit -m "feat: add PremiumUsageChart and AccountUsageChart components"
```

---

### Task 8: Statistics Page

**Files:**
- Create: `admin-ui/src/pages/statistics-page.tsx`

- [ ] **Step 1: Create StatisticsPage**

Create `admin-ui/src/pages/statistics-page.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { AccountUsageChart } from "@/components/charts/account-usage-chart"
import { PremiumUsageChart } from "@/components/charts/premium-usage-chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AdminApiError,
  getAdminPremiumStats,
  type DailyAccountStatsItem,
  type DailyStatsItem,
} from "@/lib/admin-api"
import i18n from "@/lib/i18n"

type TimePreset = "24h" | "7d" | "month" | "custom"

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function presetToParams(preset: TimePreset): {
  from: string
  to: string
  granularity: "day" | "hour"
} {
  const now = new Date()
  const today = toDateString(now)

  switch (preset) {
    case "24h": {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      return {
        from: toDateString(yesterday),
        to: today,
        granularity: "hour",
      }
    }
    case "7d": {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return { from: toDateString(weekAgo), to: today, granularity: "day" }
    }
    case "month": {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      return {
        from: toDateString(startOfMonth),
        to: today,
        granularity: "day",
      }
    }
    case "custom":
      return { from: today, to: today, granularity: "day" }
  }
}

export function StatisticsPage(): React.JSX.Element {
  const { t } = useTranslation()

  const [preset, setPreset] = useState<TimePreset>("7d")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [autoRefreshMs, setAutoRefreshMs] = useState(0)

  const [loading, setLoading] = useState(true)
  const [daily, setDaily] = useState<DailyStatsItem[]>([])
  const [byAccount, setByAccount] = useState<DailyAccountStatsItem[]>([])

  const loadInFlightRef = useRef(false)
  const queuedRefreshRef = useRef(false)
  const autoRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (loadInFlightRef.current) {
      queuedRefreshRef.current = true
      return
    }

    loadInFlightRef.current = true
    setLoading(true)

    try {
      const params =
        preset === "custom"
          ? { from: customFrom, to: customTo, granularity: "day" as const }
          : presetToParams(preset)

      const result = await getAdminPremiumStats(params)
      setDaily(result.daily)
      setByAccount(result.by_account)
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      toast.error(t("statistics.loadFailed"), { description: msg })
    } finally {
      loadInFlightRef.current = false
      setLoading(false)

      if (queuedRefreshRef.current) {
        queuedRefreshRef.current = false
        void refresh()
      }
    }
  }, [preset, customFrom, customTo, t])

  // Initial load and preset change
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Auto-refresh
  useEffect(() => {
    let disposed = false

    if (autoRefreshRef.current) {
      clearTimeout(autoRefreshRef.current)
      autoRefreshRef.current = null
    }

    if (autoRefreshMs > 0) {
      const scheduleNext = (): void => {
        if (disposed) return
        autoRefreshRef.current = setTimeout(async () => {
          if (loadInFlightRef.current) {
            scheduleNext()
            return
          }
          try {
            await refresh()
          } finally {
            scheduleNext()
          }
        }, autoRefreshMs)
      }

      scheduleNext()
    }

    return () => {
      disposed = true
      if (autoRefreshRef.current) {
        clearTimeout(autoRefreshRef.current)
        autoRefreshRef.current = null
      }
    }
  }, [autoRefreshMs, refresh])

  const isHourly = preset === "24h"

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-semibold">{t("statistics.title")}</h1>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* Time range preset */}
          <Select
            value={preset}
            onValueChange={(v) => setPreset(v as TimePreset)}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">
                {t("statistics.timeRange.24h")}
              </SelectItem>
              <SelectItem value="7d">
                {t("statistics.timeRange.7d")}
              </SelectItem>
              <SelectItem value="month">
                {t("statistics.timeRange.month")}
              </SelectItem>
              <SelectItem value="custom">
                {t("statistics.timeRange.custom")}
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Custom date inputs */}
          {preset === "custom" && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-md border bg-background px-2 py-1 text-sm"
              />
              <span className="text-muted-foreground">—</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-md border bg-background px-2 py-1 text-sm"
              />
            </div>
          )}

          {/* Auto-refresh */}
          <Select
            value={String(autoRefreshMs)}
            onValueChange={(v) => setAutoRefreshMs(Number(v))}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">
                {t("statistics.autoRefresh.off")}
              </SelectItem>
              <SelectItem value="30000">
                {t("statistics.autoRefresh.30s")}
              </SelectItem>
              <SelectItem value="60000">
                {t("statistics.autoRefresh.60s")}
              </SelectItem>
              <SelectItem value="300000">
                {t("statistics.autoRefresh.5m")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && daily.length === 0 && (
        <div className="space-y-6">
          <div className="h-96 animate-pulse rounded-xl border bg-muted" />
          <div className="h-96 animate-pulse rounded-xl border bg-muted" />
        </div>
      )}

      {/* Charts */}
      {(!loading || daily.length > 0) && (
        <div className="space-y-6">
          <PremiumUsageChart data={daily} isHourly={isHourly} />
          <AccountUsageChart data={byAccount} isHourly={isHourly} />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Run admin-ui typecheck**

Run: `cd admin-ui && npx tsc --noEmit && cd ..`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/pages/statistics-page.tsx
git commit -m "feat: add StatisticsPage with time controls and chart layout"
```

---

### Task 9: Route, Navigation, and i18n Integration

**Files:**
- Modify: `admin-ui/src/App.tsx:11-25`
- Modify: `admin-ui/src/components/app-shell.tsx:42-47`
- Modify: `admin-ui/src/locales/en-US.json`
- Modify: `admin-ui/src/locales/zh-CN.json`

- [ ] **Step 1: Add route in App.tsx**

In `admin-ui/src/App.tsx`, add import at top:

```typescript
import { StatisticsPage } from "@/pages/statistics-page"
```

Add route between `/requests` and `/models`:

```tsx
<Route path="/requests" element={<RequestsPage />} />
<Route path="/statistics" element={<StatisticsPage />} />
<Route path="/models" element={<ModelsPage />} />
```

- [ ] **Step 2: Add nav item in app-shell.tsx**

In `admin-ui/src/components/app-shell.tsx`, update `NAV_ITEMS` (line 42-47):

```typescript
const NAV_ITEMS = [
  { to: "/accounts", labelKey: "nav.accounts" },
  { to: "/requests", labelKey: "nav.requests" },
  { to: "/statistics", labelKey: "nav.statistics" },
  { to: "/models", labelKey: "nav.models" },
  { to: "/settings", labelKey: "nav.settings" },
] as const
```

- [ ] **Step 3: Add English i18n keys**

In `admin-ui/src/locales/en-US.json`, add to the `nav` section (after `"requests"`):

```json
"statistics": "Statistics",
```

Add a new `statistics` section (after `modelsPage` section):

```json
"statistics": {
  "title": "Statistics",
  "premiumUsage": "Premium Usage Trend",
  "accountUsage": "Per-Account Premium Usage",
  "costUnits": "Cost Units",
  "requestCount": "Request Count",
  "tokensTotal": "Total Tokens",
  "errorCount": "Errors",
  "timeRange": {
    "24h": "24h",
    "7d": "7 Days",
    "month": "This Month",
    "custom": "Custom"
  },
  "autoRefresh": {
    "off": "Auto-refresh: Off",
    "30s": "Every 30s",
    "60s": "Every 60s",
    "5m": "Every 5m"
  },
  "noData": "No premium request data for this period",
  "loadFailed": "Failed to load statistics"
},
```

- [ ] **Step 4: Add Chinese i18n keys**

In `admin-ui/src/locales/zh-CN.json`, add to the `nav` section:

```json
"statistics": "统计",
```

Add a new `statistics` section:

```json
"statistics": {
  "title": "统计",
  "premiumUsage": "高级请求用量趋势",
  "accountUsage": "各账号高级请求消耗",
  "costUnits": "成本单位",
  "requestCount": "请求次数",
  "tokensTotal": "总 Token 数",
  "errorCount": "错误数",
  "timeRange": {
    "24h": "24 小时",
    "7d": "7 天",
    "month": "本月",
    "custom": "自定义"
  },
  "autoRefresh": {
    "off": "自动刷新：关",
    "30s": "每 30 秒",
    "60s": "每 60 秒",
    "5m": "每 5 分钟"
  },
  "noData": "该时间段无高级请求数据",
  "loadFailed": "加载统计数据失败"
},
```

- [ ] **Step 5: Build admin-ui to verify everything compiles**

Run: `cd admin-ui && bun run build && cd ..`
Expected: Build succeeds

- [ ] **Step 6: Run full project lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add admin-ui/src/App.tsx admin-ui/src/components/app-shell.tsx admin-ui/src/locales/
git commit -m "feat: integrate Statistics page with routing, navigation, and i18n"
```

---

### Task 10: Manual Verification

- [ ] **Step 1: Start dev server**

Run: `bun run dev`

- [ ] **Step 2: Verify Statistics page loads**

Open `http://localhost:4141/admin/#/statistics`

Expected:
- Page loads with "统计" header
- Time range selector shows 24h / 7 天 / 本月 / 自定义
- Auto-refresh selector shows options
- If data exists: two charts render correctly
- If no data: "该时间段无高级请求数据" message in both chart areas

- [ ] **Step 3: Verify time range switching**

Click through presets:
- "24h": Charts should show hourly granularity (HH:00 on X-axis)
- "7 天": Charts should show daily granularity (MM-DD on X-axis)
- "本月": Charts should show from 1st of month to today
- "自定义": Date pickers should appear

- [ ] **Step 4: Verify navigation**

Check that:
- "统计" appears in the navigation bar between "请求" and "模型"
- Navigation between pages works correctly
- View transition animation works

- [ ] **Step 5: Verify dark mode**

Toggle between light and dark mode. Charts should use appropriate colors from CSS variables.

- [ ] **Step 6: Verify API endpoint directly**

Run: `curl http://localhost:4141/api/admin/stats/premium-daily`

Expected: JSON response with `daily`, `by_account`, and `range` fields.

- [ ] **Step 7: Verify admin-ui production build**

Run: `bun run build`
Expected: Build succeeds, `dist/admin/` directory updated.
