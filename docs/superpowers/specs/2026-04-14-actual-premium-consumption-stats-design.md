# Actual Premium Consumption Statistics — Design Spec

## Problem

The current statistics page displays `cost_units_sum`, which is an **estimated** value computed from each model's `billing.multiplier` metadata. This does not reflect the **actual** Premium request quota consumption as reported by GitHub's upstream Copilot API.

## Goal

Replace the model-multiplier-based estimation with actual Premium quota consumption data derived from the upstream API's `premium_interactions.remaining` field, captured via a dedicated quota snapshots table.

## Decision Record

| Question | Answer |
|---|---|
| UI presentation | Replace existing charts (no new charts) |
| Y-axis metric | Consumption per time period (not remaining balance) |
| Data architecture | New `quota_snapshots` table (方案 B) |

---

## Architecture

### Data Flow

```
refreshQuota() → getCopilotUsage() → upstream API response
  → applyQuotaRefreshSuccessIfCurrent() applies to AccountRuntime
  → insertQuotaSnapshot() writes to quota_snapshots table
  
Admin API stats endpoint
  → reads quota_snapshots with LAG() window function
  → computes consumption as SUM of remaining decreases between consecutive snapshots
  → returns premium_consumed alongside request_count, tokens_total, error_count
```

### Snapshot Capture Points

`refreshQuota()` is called:
1. During account initialization (`initializeAccount()`)
2. On-demand when quota cache expires (>45s TTL) during account selection
3. After every request completion via `finalizeQuota()`

Each successful refresh inserts one row into `quota_snapshots`.

---

## Data Layer

### New Table: `quota_snapshots`

```sql
CREATE TABLE quota_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT    NOT NULL,
  snapshot_at_ms  INTEGER NOT NULL,
  remaining       INTEGER NOT NULL,
  entitlement     INTEGER NOT NULL,
  unlimited       INTEGER NOT NULL DEFAULT 0,
  source          TEXT    NOT NULL DEFAULT 'refresh'
);

CREATE INDEX idx_quota_snapshots_account_time
  ON quota_snapshots(account_id, snapshot_at_ms);

CREATE INDEX idx_quota_snapshots_time
  ON quota_snapshots(snapshot_at_ms);
```

**Columns:**

| Column | Type | Description |
|---|---|---|
| `account_id` | TEXT | GitHub login ID |
| `snapshot_at_ms` | INTEGER | Capture timestamp (ms since epoch) |
| `remaining` | INTEGER | `premium_interactions.remaining` from upstream API |
| `entitlement` | INTEGER | `premium_interactions.entitlement` from upstream API |
| `unlimited` | INTEGER | 1 if account has unlimited quota, 0 otherwise |
| `source` | TEXT | `'refresh'`, `'init'`, or `'backfill'` |

### Migration: v10

Add `migrateV10()` to `admin-db.ts`:
- Create `quota_snapshots` table with indexes
- Backfill from `request_log.premium_remaining_after` where available
- Set `PRAGMA user_version = 10`

### Backfill SQL

```sql
INSERT INTO quota_snapshots
  (account_id, snapshot_at_ms, remaining, entitlement, unlimited, source)
SELECT
  account_id,
  finished_at_ms,
  premium_remaining_after,
  0,
  COALESCE(premium_unlimited_after, 0),
  'backfill'
FROM request_log
WHERE premium_remaining_after IS NOT NULL
  AND account_id IS NOT NULL
  AND finished_at_ms IS NOT NULL
ORDER BY finished_at_ms;
```

**Limitation:** Backfilled rows have `entitlement = 0` because `request_log` does not store this field. Consumption calculation is unaffected (only depends on `remaining` deltas).

### Retention

180 days (matching `daily_premium_stats`). Cleanup runs alongside existing `cleanupStatsRetention()`.

---

## Consumption Calculation

### Algorithm

For consecutive snapshot pairs `(snap_prev, snap_current)` of the same account:
- If `current.remaining < prev.remaining`: consumption = `prev.remaining - current.remaining`
- If `current.remaining >= prev.remaining`: quota reset occurred, consumption = 0

### SQL (Daily Granularity)

```sql
WITH baseline AS (
  -- Last snapshot before the range for each account (baseline)
  SELECT qs.account_id, qs.snapshot_at_ms, qs.remaining
  FROM quota_snapshots qs
  INNER JOIN (
    SELECT account_id, MAX(snapshot_at_ms) AS max_ts
    FROM quota_snapshots
    WHERE snapshot_at_ms < ?  -- range_start_ms
      AND unlimited = 0
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
  WHERE snapshot_at_ms >= ? AND snapshot_at_ms <= ?  -- range_start_ms, range_end_ms
    AND unlimited = 0
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
  date(snapshot_at_ms / 1000, 'unixepoch', 'localtime') AS date,
  account_id,
  SUM(
    CASE WHEN prev_remaining IS NOT NULL AND prev_remaining > remaining
         THEN prev_remaining - remaining
         ELSE 0
    END
  ) AS premium_consumed
FROM with_prev
WHERE snapshot_at_ms >= ?  -- range_start_ms (exclude baseline from output)
GROUP BY 1, 2
ORDER BY 1, 2;
```

### SQL (Hourly Granularity)

Same structure, grouped by `strftime('%Y-%m-%d %H:00', snapshot_at_ms / 1000, 'unixepoch', 'localtime')`.

---

## API Layer

### Endpoint: `GET /admin/stats/premium-daily`

**Request:** Unchanged (`from`, `to`, `account_id`, `granularity`).

**Response:** `cost_units_sum` field renamed to `premium_consumed`.

```typescript
interface DailyStats {
  date: string
  request_count: number
  premium_consumed: number  // was: cost_units_sum
  tokens_total: number
  error_count: number
}

interface DailyAccountStats extends DailyStats {
  account_id: string
}

interface PremiumStatsResponse {
  daily: Array<DailyStats>
  by_account: Array<DailyAccountStats>
  range: { from: string; to: string; granularity: "day" | "hour" }
}
```

### Query Strategy

| Granularity | `request_count`, `tokens_total`, `error_count` | `premium_consumed` |
|---|---|---|
| `day` | From `daily_premium_stats` | From `quota_snapshots` (window function) |
| `hour` | From `request_log` (GROUP BY hour) | From `quota_snapshots` (GROUP BY hour) |

Results are merged by `(date, account_id)` before returning.

### `daily_premium_stats` Table

Retained for `request_count`, `tokens_total`, `error_count` aggregation. The `cost_units_sum` column remains but is no longer surfaced in the API response.

---

## Frontend

### Type Changes

`admin-ui/src/lib/admin-api.ts`:
- `DailyStatsItem.cost_units_sum` → `DailyStatsItem.premium_consumed`
- `DailyAccountStatsItem.cost_units_sum` → `DailyAccountStatsItem.premium_consumed`

### Chart Changes

**`PremiumUsageChart`:**
- `dataKey` from `"cost_units_sum"` to `"premium_consumed"`
- No visual/layout changes

**`AccountUsageChart`:**
- Pivot data field from `cost_units_sum` to `premium_consumed`
- No visual/layout changes

### i18n

No new keys needed. The existing `"costUnits"` key was already renamed to `"Premium 消耗"` / `"Premium Usage"` in the previous PR, which accurately describes the new data source.

---

## Files Affected

| File | Change |
|---|---|
| `src/lib/admin-db.ts` | Add `migrateV10()`: create `quota_snapshots` table + backfill |
| `src/lib/accounts-manager.ts` | Insert snapshot after successful `refreshQuota()` |
| `src/lib/stats-store.ts` | Add `getConsumptionFromSnapshots()` method; update interfaces; add snapshot retention cleanup |
| `src/routes/admin-api/route.ts` | Stats endpoint: merge snapshot consumption with existing metrics; rename response field |
| `admin-ui/src/lib/admin-api.ts` | Rename `cost_units_sum` → `premium_consumed` in type definitions |
| `admin-ui/src/components/charts/premium-usage-chart.tsx` | Update `dataKey` reference |
| `admin-ui/src/components/charts/account-usage-chart.tsx` | Update pivot field reference |

---

## Testing

- **Unit:** Consumption calculation with various snapshot sequences (normal, reset, gaps, unlimited accounts)
- **Migration:** Verify v10 migration creates table and backfills correctly
- **API:** Stats endpoint returns `premium_consumed` with correct values
- **Frontend:** Charts render with new field name (manual verification)

## Out of Scope

- "Remaining quota" trend chart (YAGNI — can be added later using the same snapshot data)
- Real-time quota dashboard cards
- Alerting on quota thresholds
