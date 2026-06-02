# Actual Premium Consumption Statistics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace model-multiplier-based estimated cost_units with actual Premium quota consumption derived from the upstream API's `premium_interactions.remaining` field via a dedicated quota snapshots table.

**Architecture:** A new `quota_snapshots` table captures remaining quota from each `refreshQuota()` call. Consumption is computed at query time via SQLite window functions (LAG over consecutive snapshots). The admin API merges this with existing request metrics, and the frontend charts display `premium_consumed` instead of `cost_units_sum`.

**Tech Stack:** Bun SQLite, Hono, React + Recharts, bun:test

**Spec:** `docs/superpowers/specs/2026-04-14-actual-premium-consumption-stats-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/admin-db.ts` | DB migration v10: create `quota_snapshots` table + backfill |
| `src/lib/stats-store.ts` | Snapshot insertion, consumption queries, retention cleanup, updated interfaces |
| `src/lib/accounts-manager.ts` | Call `insertQuotaSnapshot()` after successful `refreshQuota()` |
| `src/routes/admin-api/route.ts` | Stats endpoint: merge snapshot consumption with existing metrics |
| `admin-ui/src/lib/admin-api.ts` | Type rename: `cost_units_sum` → `premium_consumed` |
| `admin-ui/src/components/charts/premium-usage-chart.tsx` | Update dataKey and tooltip field |
| `admin-ui/src/components/charts/account-usage-chart.tsx` | Update pivot field |
| `tests/stats-store.test.ts` | Tests for migration, snapshot insertion, consumption calculation |

---

### Task 1: DB Migration — `quota_snapshots` Table

**Files:**
- Modify: `src/lib/admin-db.ts:225-329` (migration chain)
- Test: `tests/stats-store.test.ts`

- [ ] **Step 1: Write the failing test for v10 migration**

Add to `tests/stats-store.test.ts`:

```typescript
test("initAdminDb migrates admin DB to user_version 10", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(10)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/stats-store.test.ts`
Expected: FAIL — `initAdminDb migrates admin DB to user_version 10` fails (still at 9), `quota_snapshots table has the expected columns` fails (table doesn't exist).

- [ ] **Step 3: Implement migrateV10 in admin-db.ts**

Add the `migrateV10` function before `migrateAdminDb`:

```typescript
function migrateV10(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS quota_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id      TEXT    NOT NULL,
      snapshot_at_ms  INTEGER NOT NULL,
      remaining       INTEGER NOT NULL,
      entitlement     INTEGER NOT NULL,
      unlimited       INTEGER NOT NULL DEFAULT 0,
      source          TEXT    NOT NULL DEFAULT 'refresh'
    );

    CREATE INDEX IF NOT EXISTS idx_quota_snapshots_account_time
      ON quota_snapshots(account_id, snapshot_at_ms);

    CREATE INDEX IF NOT EXISTS idx_quota_snapshots_time
      ON quota_snapshots(snapshot_at_ms);
  `)

  // Backfill from existing request_log
  const hasRequestLog = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'request_log' LIMIT 1;",
    )
    .get()

  if (hasRequestLog) {
    db.run(`
      INSERT INTO quota_snapshots
        (account_id, snapshot_at_ms, remaining, entitlement, unlimited, source)
      SELECT
        account_id,
        finished_at_ms,
        CAST(premium_remaining_after AS INTEGER),
        0,
        COALESCE(premium_unlimited_after, 0),
        'backfill'
      FROM request_log
      WHERE premium_remaining_after IS NOT NULL
        AND account_id IS NOT NULL
        AND finished_at_ms IS NOT NULL
      ORDER BY finished_at_ms;
    `)
  }

  db.run("PRAGMA user_version = 10;")
}
```

Update `migrateAdminDb` — change the early-return guard and add `migrateV10` call:

```typescript
function migrateAdminDb(db: Database): void {
  const row = db.query("PRAGMA user_version;").get() as {
    user_version?: number
  } | null
  const current = row?.user_version ?? 0

  if (current >= 10) {   // was: >= 9
    return
  }

  // ... existing v1-v7 migrations unchanged ...

  migrateV8(db)
  migrateV9(db)
  migrateV10(db)          // NEW
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/stats-store.test.ts`
Expected: All tests PASS. Update the old test `"initAdminDb migrates admin DB to user_version 9"` — change expected version to 10:

```typescript
test("initAdminDb migrates admin DB to user_version 10", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(10)
})
```

- [ ] **Step 5: Write test for v10 backfill from request_log**

```typescript
test("v10 migration backfills quota_snapshots from request_log", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  // Reset to v9 and drop snapshots table to test backfill
  db.run("PRAGMA user_version = 9;")
  db.run("DROP TABLE IF EXISTS quota_snapshots;")

  // Insert test data into request_log
  const baseMs = new Date("2026-04-10T12:00:00").getTime()
  db.run(
    `INSERT INTO request_log
       (request_id, started_at_ms, finished_at_ms, method, path, account_id,
        cost_units, premium_remaining_after, premium_unlimited_after)
     VALUES
       ('qs-1', ?, ?, 'POST', '/v1/messages', 'acct-a', 10.0, 290, 0),
       ('qs-2', ?, ?, 'POST', '/v1/messages', 'acct-a', 5.0, 285, 0),
       ('qs-3', ?, ?, 'POST', '/v1/messages', 'acct-b', 8.0, 192, 0)`,
    [baseMs, baseMs + 100, baseMs + 1000, baseMs + 1100, baseMs + 2000, baseMs + 2100],
  )

  // Re-run migration
  initAdminDb(db)

  const rows = db
    .query(
      "SELECT account_id, remaining, source FROM quota_snapshots ORDER BY snapshot_at_ms",
    )
    .all() as Array<{ account_id: string; remaining: number; source: string }>

  expect(rows.length).toBe(3)
  expect(rows[0]).toEqual({ account_id: "acct-a", remaining: 290, source: "backfill" })
  expect(rows[1]).toEqual({ account_id: "acct-a", remaining: 285, source: "backfill" })
  expect(rows[2]).toEqual({ account_id: "acct-b", remaining: 192, source: "backfill" })
})
```

- [ ] **Step 6: Run tests to verify backfill test passes**

Run: `bun test tests/stats-store.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin-db.ts tests/stats-store.test.ts
git commit -m "feat: add quota_snapshots table migration (v10) with request_log backfill"
```

---

### Task 2: Snapshot Insertion via StatsStore

**Files:**
- Modify: `src/lib/stats-store.ts:30-65` (StatsStore class)
- Modify: `src/lib/accounts-manager.ts:730-737` (refreshQuota)
- Test: `tests/stats-store.test.ts`

- [ ] **Step 1: Write the failing test for insertQuotaSnapshot**

Add to `tests/stats-store.test.ts`:

```typescript
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
    .query("SELECT account_id, remaining, entitlement, unlimited, source FROM quota_snapshots")
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/stats-store.test.ts`
Expected: FAIL — `store.insertQuotaSnapshot is not a function`.

- [ ] **Step 3: Implement insertQuotaSnapshot in StatsStore**

In `src/lib/stats-store.ts`, add a new prepared statement and method to `StatsStore`:

```typescript
export class StatsStore {
  private readonly db: Database
  private readonly upsertStmt: ReturnType<Database["query"]>
  private readonly insertSnapshotStmt: ReturnType<Database["query"]>

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
    this.insertSnapshotStmt = db.query(`
      INSERT INTO quota_snapshots
        (account_id, snapshot_at_ms, remaining, entitlement, unlimited, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
  }

  insertQuotaSnapshot(record: {
    accountId: string
    snapshotAtMs: number
    remaining: number
    entitlement: number
    unlimited: boolean
    source: string
  }): void {
    this.insertSnapshotStmt.run(
      record.accountId,
      record.snapshotAtMs,
      record.remaining,
      record.entitlement,
      record.unlimited ? 1 : 0,
      record.source,
    )
  }

  // ... existing methods unchanged ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/stats-store.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Wire snapshot insertion into accounts-manager.ts**

In `src/lib/accounts-manager.ts`, inside `refreshQuota()`, after line 737 (`applyQuotaRefreshSuccessIfCurrent` call), add the snapshot insertion:

```typescript
// Inside the try block of refreshQuota(), after applyQuotaRefreshSuccessIfCurrent:
const usage = await getCopilotUsage(ctx)
const premium = usage.quota_snapshots.premium_interactions
const applied = applyQuotaRefreshSuccessIfCurrent(account, snapshot, {
  premium,
  copilotApiUrl: usage.endpoints.api,
})

if (applied) {
  try {
    getStatsStore()?.insertQuotaSnapshot({
      accountId: account.id,
      snapshotAtMs: Date.now(),
      remaining: premium.remaining,
      entitlement: premium.entitlement,
      unlimited: premium.unlimited,
      source: "refresh",
    })
  } catch {
    // Best-effort: don't fail the quota refresh if snapshot insert fails
  }
}
```

This requires importing `getStatsStore` at the top of `accounts-manager.ts`:

```typescript
import { getStatsStore } from "./request-history"
```

Note: `applyQuotaRefreshSuccessIfCurrent` currently returns `void` in the call site but is typed to return `boolean`. The return value needs to be captured into a variable `applied`. Change line 734 from:

```typescript
applyQuotaRefreshSuccessIfCurrent(account, snapshot, {
  premium,
  copilotApiUrl: usage.endpoints.api,
})
```

to:

```typescript
const applied = applyQuotaRefreshSuccessIfCurrent(account, snapshot, {
  premium,
  copilotApiUrl: usage.endpoints.api,
})
```

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All tests PASS. No regressions.

- [ ] **Step 7: Commit**

```bash
git add src/lib/stats-store.ts src/lib/accounts-manager.ts tests/stats-store.test.ts
git commit -m "feat: insert quota snapshots on successful refreshQuota"
```

---

### Task 3: Consumption Calculation from Snapshots

**Files:**
- Modify: `src/lib/stats-store.ts` (add consumption query methods)
- Test: `tests/stats-store.test.ts`

- [ ] **Step 1: Write the failing test for daily consumption calculation**

```typescript
test("getConsumptionFromSnapshots computes daily consumption from remaining deltas", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Day 1: remaining goes 300 → 290 → 280 (consumed 20)
  const day1_t1 = new Date("2026-04-10T08:00:00").getTime()
  const day1_t2 = new Date("2026-04-10T12:00:00").getTime()
  const day1_t3 = new Date("2026-04-10T16:00:00").getTime()

  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: day1_t1, remaining: 300, entitlement: 300, unlimited: false, source: "refresh" })
  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: day1_t2, remaining: 290, entitlement: 300, unlimited: false, source: "refresh" })
  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: day1_t3, remaining: 280, entitlement: 300, unlimited: false, source: "refresh" })

  // Day 2: remaining goes 280 → 270 (consumed 10)
  const day2_t1 = new Date("2026-04-11T10:00:00").getTime()
  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: day2_t1, remaining: 270, entitlement: 300, unlimited: false, source: "refresh" })

  const fromMs = new Date("2026-04-10T00:00:00").getTime()
  const toMs = new Date("2026-04-11T23:59:59.999").getTime()

  const result = store.getConsumptionFromSnapshots({ fromMs, toMs, granularity: "day" })

  // acct-a day 2026-04-10: consumed 20 (300→280)
  // acct-a day 2026-04-11: consumed 10 (280→270)
  expect(result.length).toBeGreaterThanOrEqual(2)

  const day1 = result.find((r) => r.date.includes("04-10") && r.account_id === "acct-a")
  expect(day1?.premium_consumed).toBe(20)

  const day2 = result.find((r) => r.date.includes("04-11") && r.account_id === "acct-a")
  expect(day2?.premium_consumed).toBe(10)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/stats-store.test.ts`
Expected: FAIL — `store.getConsumptionFromSnapshots is not a function`.

- [ ] **Step 3: Write the failing test for quota reset handling**

```typescript
test("getConsumptionFromSnapshots handles quota reset (remaining increases)", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // remaining: 50 → 20 (consumed 30), then reset → 300 → 290 (consumed 10)
  const t1 = new Date("2026-04-10T08:00:00").getTime()
  const t2 = new Date("2026-04-10T10:00:00").getTime()
  const t3 = new Date("2026-04-10T12:00:00").getTime() // reset
  const t4 = new Date("2026-04-10T14:00:00").getTime()

  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: t1, remaining: 50, entitlement: 300, unlimited: false, source: "refresh" })
  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: t2, remaining: 20, entitlement: 300, unlimited: false, source: "refresh" })
  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: t3, remaining: 300, entitlement: 300, unlimited: false, source: "refresh" })
  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: t4, remaining: 290, entitlement: 300, unlimited: false, source: "refresh" })

  const result = store.getConsumptionFromSnapshots({
    fromMs: t1,
    toMs: t4 + 1,
    granularity: "day",
  })

  const day = result.find((r) => r.account_id === "acct-a")
  // 30 (50→20) + 0 (reset 20→300) + 10 (300→290) = 40
  expect(day?.premium_consumed).toBe(40)
})
```

- [ ] **Step 4: Write the failing test for unlimited accounts (excluded)**

```typescript
test("getConsumptionFromSnapshots excludes unlimited accounts", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  const t1 = new Date("2026-04-10T08:00:00").getTime()
  const t2 = new Date("2026-04-10T12:00:00").getTime()

  store.insertQuotaSnapshot({ accountId: "acct-unlimited", snapshotAtMs: t1, remaining: 999, entitlement: 999, unlimited: true, source: "refresh" })
  store.insertQuotaSnapshot({ accountId: "acct-unlimited", snapshotAtMs: t2, remaining: 990, entitlement: 999, unlimited: true, source: "refresh" })

  const result = store.getConsumptionFromSnapshots({
    fromMs: t1,
    toMs: t2 + 1,
    granularity: "day",
  })

  expect(result.length).toBe(0)
})
```

- [ ] **Step 5: Write the failing test for baseline snapshot (pre-range)**

```typescript
test("getConsumptionFromSnapshots uses baseline snapshot before range", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new StatsStore(db)

  // Baseline: before range
  const baseline = new Date("2026-04-09T23:00:00").getTime()
  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: baseline, remaining: 300, entitlement: 300, unlimited: false, source: "refresh" })

  // In range: remaining drops
  const t1 = new Date("2026-04-10T08:00:00").getTime()
  store.insertQuotaSnapshot({ accountId: "acct-a", snapshotAtMs: t1, remaining: 290, entitlement: 300, unlimited: false, source: "refresh" })

  const fromMs = new Date("2026-04-10T00:00:00").getTime()
  const toMs = new Date("2026-04-10T23:59:59.999").getTime()

  const result = store.getConsumptionFromSnapshots({ fromMs, toMs, granularity: "day" })

  const day = result.find((r) => r.account_id === "acct-a")
  // Baseline 300 → 290 = consumed 10
  expect(day?.premium_consumed).toBe(10)
})
```

- [ ] **Step 6: Implement getConsumptionFromSnapshots**

In `src/lib/stats-store.ts`, add the method to `StatsStore`:

```typescript
getConsumptionFromSnapshots(params: {
  fromMs: number
  toMs: number
  granularity: "day" | "hour"
  accountId?: string
}): Array<{ date: string; account_id: string; premium_consumed: number }> {
  const dateExpr =
    params.granularity === "hour"
      ? "strftime('%Y-%m-%d %H:00', snapshot_at_ms / 1000, 'unixepoch', 'localtime')"
      : "date(snapshot_at_ms / 1000, 'unixepoch', 'localtime')"

  const accountFilter = params.accountId ? " AND qs.account_id = ?" : ""
  const accountFilterInner = params.accountId ? " AND account_id = ?" : ""

  const baselineArgs: Array<string | number> = [params.fromMs]
  if (params.accountId) baselineArgs.push(params.accountId)

  const rangeArgs: Array<string | number> = [params.fromMs, params.toMs]
  if (params.accountId) rangeArgs.push(params.accountId)

  const allArgs = [...baselineArgs, ...rangeArgs, params.fromMs]

  return this.db
    .query(
      `WITH baseline AS (
        SELECT qs.account_id, qs.snapshot_at_ms, qs.remaining
        FROM quota_snapshots qs
        INNER JOIN (
          SELECT account_id, MAX(snapshot_at_ms) AS max_ts
          FROM quota_snapshots
          WHERE snapshot_at_ms < ?
            AND unlimited = 0${accountFilterInner}
          GROUP BY account_id
        ) latest ON qs.account_id = latest.account_id
                AND qs.snapshot_at_ms = latest.max_ts
      ),
      all_snaps AS (
        SELECT account_id, snapshot_at_ms, remaining
        FROM baseline
        UNION ALL
        SELECT account_id, snapshot_at_ms, remaining
        FROM quota_snapshots
        WHERE snapshot_at_ms >= ? AND snapshot_at_ms <= ?
          AND unlimited = 0${accountFilterInner}
      ),
      with_prev AS (
        SELECT
          account_id,
          snapshot_at_ms,
          remaining,
          LAG(remaining) OVER (
            PARTITION BY account_id ORDER BY snapshot_at_ms
          ) AS prev_remaining
        FROM all_snaps
      )
      SELECT
        ${dateExpr} AS date,
        account_id,
        SUM(
          CASE WHEN prev_remaining IS NOT NULL AND prev_remaining > remaining
               THEN prev_remaining - remaining
               ELSE 0
          END
        ) AS premium_consumed
      FROM with_prev
      WHERE snapshot_at_ms >= ?
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    )
    .all(...allArgs) as Array<{
    date: string
    account_id: string
    premium_consumed: number
  }>
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/stats-store.test.ts`
Expected: All tests PASS including the four new consumption tests.

- [ ] **Step 8: Commit**

```bash
git add src/lib/stats-store.ts tests/stats-store.test.ts
git commit -m "feat: add consumption calculation from quota snapshots with window functions"
```

---

### Task 4: Update Stats API Endpoint

**Files:**
- Modify: `src/lib/stats-store.ts:5-21` (interface updates)
- Modify: `src/routes/admin-api/route.ts:1658-1728` (stats endpoint)
- Modify: `src/lib/stats-store.ts:150-163` (retention cleanup)
- Test: `tests/stats-store.test.ts`

- [ ] **Step 1: Update TypeScript interfaces in stats-store.ts**

Change `DailyStats` interface — rename `cost_units_sum` to `premium_consumed`:

```typescript
export interface DailyStats {
  date: string
  request_count: number
  premium_consumed: number  // was: cost_units_sum
  tokens_total: number
  error_count: number
}
```

`DailyAccountStats` and `PremiumStatsResponse` are unchanged (they extend/use `DailyStats`).

- [ ] **Step 2: Update getDailyPremiumStats to merge consumption**

Modify `getDailyPremiumStats` in `StatsStore` to merge consumption from snapshots:

```typescript
getDailyPremiumStats(params: {
  from: string
  to: string
  accountId?: string
}): { daily: Array<DailyStats>; byAccount: Array<DailyAccountStats> } {
  const accountFilter = params.accountId ? " AND account_id = ?" : ""
  const args: Array<string | number> = [params.from, params.to]
  if (params.accountId) args.push(params.accountId)

  // Get request metrics from daily_premium_stats (request_count, tokens, errors)
  const dailyMetrics = this.db
    .query(
      `SELECT date,
              SUM(request_count)  AS request_count,
              SUM(tokens_total)   AS tokens_total,
              SUM(error_count)    AS error_count
       FROM daily_premium_stats
       WHERE date >= ? AND date <= ?${accountFilter}
       GROUP BY date
       ORDER BY date`,
    )
    .all(...args) as Array<{
    date: string
    request_count: number
    tokens_total: number
    error_count: number
  }>

  const byAccountMetrics = this.db
    .query(
      `SELECT date, account_id, request_count, tokens_total, error_count
       FROM daily_premium_stats
       WHERE date >= ? AND date <= ?${accountFilter}
       ORDER BY date, account_id`,
    )
    .all(...args) as Array<{
    date: string
    account_id: string
    request_count: number
    tokens_total: number
    error_count: number
  }>

  // Get consumption from quota_snapshots
  // Parse date strings as local midnight timestamps
  const fromMs = this.localDateToMs(params.from)
  const toMs = this.localDateToMs(params.to) + 86_399_999

  const consumption = this.getConsumptionFromSnapshots({
    fromMs,
    toMs,
    granularity: "day",
    accountId: params.accountId,
  })

  // Build consumption lookup: Map<"date|account_id", number>
  const consumptionMap = new Map<string, number>()
  for (const c of consumption) {
    consumptionMap.set(`${c.date}|${c.account_id}`, c.premium_consumed)
  }

  // Also build a date-level total map
  const dailyConsumptionMap = new Map<string, number>()
  for (const c of consumption) {
    dailyConsumptionMap.set(
      c.date,
      (dailyConsumptionMap.get(c.date) ?? 0) + c.premium_consumed,
    )
  }

  // Merge: ensure all dates from either source appear
  const allDates = new Set([
    ...dailyMetrics.map((m) => m.date),
    ...consumption.map((c) => c.date),
  ])

  const metricsMap = new Map(dailyMetrics.map((m) => [m.date, m]))

  const daily: Array<DailyStats> = [...allDates]
    .sort()
    .map((date) => {
      const m = metricsMap.get(date)
      return {
        date,
        request_count: m?.request_count ?? 0,
        premium_consumed: dailyConsumptionMap.get(date) ?? 0,
        tokens_total: m?.tokens_total ?? 0,
        error_count: m?.error_count ?? 0,
      }
    })

  // Merge by_account
  const allAccountDateKeys = new Set([
    ...byAccountMetrics.map((m) => `${m.date}|${m.account_id}`),
    ...consumption.map((c) => `${c.date}|${c.account_id}`),
  ])

  const byAccountMetricsMap = new Map(
    byAccountMetrics.map((m) => [`${m.date}|${m.account_id}`, m]),
  )

  const byAccount: Array<DailyAccountStats> = [...allAccountDateKeys]
    .sort()
    .map((key) => {
      const [date, account_id] = key.split("|")
      const m = byAccountMetricsMap.get(key)
      return {
        date,
        account_id,
        request_count: m?.request_count ?? 0,
        premium_consumed: consumptionMap.get(key) ?? 0,
        tokens_total: m?.tokens_total ?? 0,
        error_count: m?.error_count ?? 0,
      }
    })

  return { daily, byAccount }
}
```

Add the `localDateToMs` helper as a private method:

```typescript
private localDateToMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number)
  return new Date(y, m - 1, d).getTime()
}
```

- [ ] **Step 3: Update getHourlyPremiumStats similarly**

Modify `getHourlyPremiumStats` to merge hourly consumption:

```typescript
getHourlyPremiumStats(params: {
  fromMs: number
  toMs: number
  accountId?: string
}): { daily: Array<DailyStats>; byAccount: Array<DailyAccountStats> } {
  const accountFilter = params.accountId ? " AND account_id = ?" : ""
  const dailyArgs: Array<string | number> = [params.fromMs, params.toMs]
  if (params.accountId) dailyArgs.push(params.accountId)

  const dailyMetrics = this.db
    .query(
      `SELECT strftime('%Y-%m-%d %H:00', started_at_ms / 1000, 'unixepoch', 'localtime') AS date,
              COUNT(*)                                                   AS request_count,
              COALESCE(SUM(tokens_total), 0)                             AS tokens_total,
              SUM(CASE WHEN error_name IS NOT NULL THEN 1 ELSE 0 END)    AS error_count
       FROM request_log
       WHERE cost_units > 0
         AND started_at_ms >= ? AND started_at_ms <= ?${accountFilter}
       GROUP BY 1
       ORDER BY 1`,
    )
    .all(...dailyArgs) as Array<{
    date: string
    request_count: number
    tokens_total: number
    error_count: number
  }>

  const byAccountFilter =
    params.accountId ? " AND account_id = ?" : " AND account_id IS NOT NULL"
  const byAccountArgs: Array<string | number> = [params.fromMs, params.toMs]
  if (params.accountId) byAccountArgs.push(params.accountId)

  const byAccountMetrics = this.db
    .query(
      `SELECT strftime('%Y-%m-%d %H:00', started_at_ms / 1000, 'unixepoch', 'localtime') AS date,
              account_id,
              COUNT(*)                                                   AS request_count,
              COALESCE(SUM(tokens_total), 0)                             AS tokens_total,
              SUM(CASE WHEN error_name IS NOT NULL THEN 1 ELSE 0 END)    AS error_count
       FROM request_log
       WHERE cost_units > 0
         AND started_at_ms >= ? AND started_at_ms <= ?${byAccountFilter}
       GROUP BY 1, 2
       ORDER BY 1, 2`,
    )
    .all(...byAccountArgs) as Array<{
    date: string
    account_id: string
    request_count: number
    tokens_total: number
    error_count: number
  }>

  // Get consumption from snapshots (hourly)
  const consumption = this.getConsumptionFromSnapshots({
    fromMs: params.fromMs,
    toMs: params.toMs,
    granularity: "hour",
    accountId: params.accountId,
  })

  // Merge using same pattern as daily
  const consumptionMap = new Map<string, number>()
  for (const c of consumption) {
    consumptionMap.set(`${c.date}|${c.account_id}`, c.premium_consumed)
  }
  const hourlyConsumptionMap = new Map<string, number>()
  for (const c of consumption) {
    hourlyConsumptionMap.set(
      c.date,
      (hourlyConsumptionMap.get(c.date) ?? 0) + c.premium_consumed,
    )
  }

  const allDates = new Set([
    ...dailyMetrics.map((m) => m.date),
    ...consumption.map((c) => c.date),
  ])
  const metricsMap = new Map(dailyMetrics.map((m) => [m.date, m]))

  const daily: Array<DailyStats> = [...allDates]
    .sort()
    .map((date) => {
      const m = metricsMap.get(date)
      return {
        date,
        request_count: m?.request_count ?? 0,
        premium_consumed: hourlyConsumptionMap.get(date) ?? 0,
        tokens_total: m?.tokens_total ?? 0,
        error_count: m?.error_count ?? 0,
      }
    })

  const allAccountDateKeys = new Set([
    ...byAccountMetrics.map((m) => `${m.date}|${m.account_id}`),
    ...consumption.map((c) => `${c.date}|${c.account_id}`),
  ])
  const byAccountMetricsMap = new Map(
    byAccountMetrics.map((m) => [`${m.date}|${m.account_id}`, m]),
  )

  const byAccount: Array<DailyAccountStats> = [...allAccountDateKeys]
    .sort()
    .map((key) => {
      const [date, account_id] = key.split("|")
      const m = byAccountMetricsMap.get(key)
      return {
        date,
        account_id,
        request_count: m?.request_count ?? 0,
        premium_consumed: consumptionMap.get(key) ?? 0,
        tokens_total: m?.tokens_total ?? 0,
        error_count: m?.error_count ?? 0,
      }
    })

  return { daily, byAccount }
}
```

- [ ] **Step 4: Add snapshot retention cleanup**

Update `cleanupStatsRetention` in `StatsStore`:

```typescript
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

    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    this.db
      .query("DELETE FROM quota_snapshots WHERE snapshot_at_ms < ?;")
      .run(cutoffMs)
  } catch (error) {
    consola.debug("Failed to cleanup stats retention", error)
  }
}
```

- [ ] **Step 5: Update existing tests that reference cost_units_sum in query results**

In `tests/stats-store.test.ts`, update the tests that call `getDailyPremiumStats` and `getHourlyPremiumStats` to expect `premium_consumed` instead of `cost_units_sum`:

For `getDailyPremiumStats returns aggregated daily totals`:
```typescript
// Change:
expect(result.daily[0].cost_units_sum).toBe(15.0)
// To:
expect(result.daily[0].premium_consumed).toBe(0) // No snapshots inserted, so consumption = 0
```

For `getDailyPremiumStats filters by account_id`:
```typescript
// Change:
expect(result.daily[0].cost_units_sum).toBe(10.0)
// To:
expect(result.daily[0].premium_consumed).toBe(0)
```

For `getHourlyPremiumStats aggregates by hour from request_log`:
```typescript
// Change:
expect(result.daily[0].cost_units_sum).toBe(15.0)
// To:
expect(result.daily[0].premium_consumed).toBe(0)
```

Note: These tests only insert into `request_log`/`daily_premium_stats` but not `quota_snapshots`, so `premium_consumed` will be 0. The consumption tests in Task 3 validate the actual computation.

- [ ] **Step 6: Run tests to verify**

Run: `bun test tests/stats-store.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Run lint**

Run: `bun run lint`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/stats-store.ts src/routes/admin-api/route.ts tests/stats-store.test.ts
git commit -m "feat: merge actual consumption from quota snapshots into stats API response"
```

---

### Task 5: Frontend — Type Rename and Chart Updates

**Files:**
- Modify: `admin-ui/src/lib/admin-api.ts:189-205`
- Modify: `admin-ui/src/components/charts/premium-usage-chart.tsx:54,146`
- Modify: `admin-ui/src/components/charts/account-usage-chart.tsx:97`

- [ ] **Step 1: Rename type field in admin-api.ts**

In `admin-ui/src/lib/admin-api.ts`, change the `DailyStatsItem` type:

```typescript
export type DailyStatsItem = {
  date: string
  request_count: number
  premium_consumed: number  // was: cost_units_sum
  tokens_total: number
  error_count: number
}
```

- [ ] **Step 2: Update PremiumUsageChart**

In `admin-ui/src/components/charts/premium-usage-chart.tsx`:

Line 54 — tooltip value:
```tsx
// Change:
{item.cost_units_sum}
// To:
{item.premium_consumed}
```

Line 146 — Area dataKey:
```tsx
// Change:
dataKey="cost_units_sum"
// To:
dataKey="premium_consumed"
```

- [ ] **Step 3: Update AccountUsageChart**

In `admin-ui/src/components/charts/account-usage-chart.tsx`:

Line 97 — pivot data:
```tsx
// Change:
row[item.account_id] = item.cost_units_sum
// To:
row[item.account_id] = item.premium_consumed
```

- [ ] **Step 4: Run admin lint**

Run: `bun run lint:admin`
Expected: No errors.

- [ ] **Step 5: Build admin UI**

Run: `bun run build:admin`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 6: Run full project typecheck**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add admin-ui/src/lib/admin-api.ts admin-ui/src/components/charts/premium-usage-chart.tsx admin-ui/src/components/charts/account-usage-chart.tsx
git commit -m "feat: update frontend to display premium_consumed from quota snapshots"
```

---

### Task 6: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS.

- [ ] **Step 2: Run full lint**

Run: `bun run lint && bun run lint:admin`
Expected: No errors.

- [ ] **Step 3: Full build**

Run: `bun run build`
Expected: Build succeeds.
