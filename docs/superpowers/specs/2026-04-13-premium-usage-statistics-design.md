# Premium Usage Statistics — Design Spec

## Goal

Add a Statistics page to the admin UI that visualizes daily premium request usage with two line/area charts:

1. **Total Premium Usage Trend** — overall daily cost units consumed and request count
2. **Per-Account Premium Usage Trend** — daily cost units consumed broken down by upstream account

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Y-axis metric | Both `SUM(cost_units)` and `COUNT` | Full picture: cost reflects quota impact; count reflects activity |
| Page placement | New `/statistics` route | Dedicated space, good extensibility |
| Time range | Presets (24h / 7d / this month) + custom date picker | Matches existing UX patterns while adding flexibility |
| 24h granularity | Hourly (from `request_log`) | Daily granularity yields only 1-2 points for 24h; hourly is informative |
| Chart library | Recharts | shadcn/ui recommended, matches existing CSS chart variables |
| Aggregation strategy | Write-time upsert into dedicated stats table | Real-time, simple, reliable; negligible per-request overhead |
| Stats retention | 180 days (independent of `request_log` 14-day policy) | Stats table is lightweight; longer retention enables trend analysis |

---

## 1. Data Layer

### 1.1 New Table: `daily_premium_stats`

Created during DB migration (bump `user_version` to 9).

```sql
CREATE TABLE IF NOT EXISTS daily_premium_stats (
  date            TEXT    NOT NULL,   -- ISO 'YYYY-MM-DD', server local timezone
  account_id      TEXT    NOT NULL,   -- GitHub login
  request_count   INTEGER NOT NULL DEFAULT 0,
  cost_units_sum  REAL    NOT NULL DEFAULT 0,
  tokens_total    INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  updated_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (date, account_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_premium_stats_date
  ON daily_premium_stats(date);
```

Design notes:
- One row per `(date, account_id)` pair.
- No synthetic "total" rows — global aggregation is computed at query time via `SUM ... GROUP BY date`.
- `error_count` is cheap to maintain and useful for trend analysis.
- `updated_at_ms` aids debugging and incremental verification.

### 1.2 Write-Time Aggregation

In `request-history.ts` `insert()`, when `cost_units > 0` and `account_id` is present, execute an atomic upsert:

```sql
INSERT INTO daily_premium_stats
  (date, account_id, request_count, cost_units_sum, tokens_total, error_count, updated_at_ms)
VALUES (?, ?, 1, ?, ?, ?, ?)
ON CONFLICT(date, account_id) DO UPDATE SET
  request_count   = request_count  + 1,
  cost_units_sum  = cost_units_sum + excluded.cost_units_sum,
  tokens_total    = tokens_total   + excluded.tokens_total,
  error_count     = error_count    + excluded.error_count,
  updated_at_ms   = excluded.updated_at_ms;
```

Date derivation uses server-local time to match the user's day boundary perception:

```typescript
function toLocalDateString(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
```

Note: do NOT use `toISOString().slice(0, 10)` — that returns UTC which misaligns day boundaries for non-UTC servers.

### 1.3 Historical Backfill

During the v8→v9 migration, backfill from existing `request_log`:

```sql
INSERT INTO daily_premium_stats
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
  updated_at_ms   = excluded.updated_at_ms;
```

### 1.4 Retention Policy

- Default: **180 days** (`DEFAULT_STATS_RETENTION_DAYS = 180`).
- Configurable via `config.json` field `statsRetentionDays`.
- Cleanup runs alongside `request_log` cleanup (daily interval):
  ```sql
  DELETE FROM daily_premium_stats WHERE date < ?;
  ```
  Where `?` is `toLocalDateString(Date.now() - statsRetentionDays * 86400000)`.

---

## 2. Backend API

### 2.1 Endpoint: `GET /api/admin/stats/premium-daily`

Registered in `src/routes/admin-api/route.ts` under the existing admin auth middleware.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from` | `YYYY-MM-DD` | 7 days ago | Start date (inclusive) |
| `to` | `YYYY-MM-DD` | today | End date (inclusive) |
| `account_id` | string | — | Filter to a specific account |
| `granularity` | `day` \| `hour` | `day` | `hour` only valid when range ≤ 48h |

**Response shape:**

```typescript
interface PremiumStatsResponse {
  daily: Array<{
    date: string           // 'YYYY-MM-DD' or 'YYYY-MM-DD HH:00' for hourly
    request_count: number
    cost_units_sum: number
    tokens_total: number
    error_count: number
  }>
  by_account: Array<{
    date: string
    account_id: string
    request_count: number
    cost_units_sum: number
    tokens_total: number
    error_count: number
  }>
  range: { from: string; to: string; granularity: 'day' | 'hour' }
}
```

### 2.2 Query Logic

**Day granularity** — reads from `daily_premium_stats`:

```sql
-- daily totals
SELECT date,
       SUM(request_count)  AS request_count,
       SUM(cost_units_sum) AS cost_units_sum,
       SUM(tokens_total)   AS tokens_total,
       SUM(error_count)    AS error_count
FROM daily_premium_stats
WHERE date >= ? AND date <= ?
GROUP BY date ORDER BY date;

-- by_account
SELECT date, account_id, request_count, cost_units_sum, tokens_total, error_count
FROM daily_premium_stats
WHERE date >= ? AND date <= ?
ORDER BY date, account_id;
```

When `account_id` is specified, add `AND account_id = ?` to both queries.

**Hour granularity** — reads from `request_log` directly:

```sql
-- daily totals (hourly buckets)
SELECT strftime('%Y-%m-%d %H:00', started_at_ms / 1000, 'unixepoch', 'localtime') AS date,
       COUNT(*)           AS request_count,
       SUM(cost_units)    AS cost_units_sum,
       COALESCE(SUM(tokens_total), 0) AS tokens_total,
       SUM(CASE WHEN error_name IS NOT NULL THEN 1 ELSE 0 END) AS error_count
FROM request_log
WHERE cost_units > 0
  AND started_at_ms >= ? AND started_at_ms <= ?
GROUP BY 1 ORDER BY 1;

-- by_account (hourly buckets)
SELECT strftime('%Y-%m-%d %H:00', started_at_ms / 1000, 'unixepoch', 'localtime') AS date,
       account_id,
       COUNT(*)           AS request_count,
       SUM(cost_units)    AS cost_units_sum,
       COALESCE(SUM(tokens_total), 0) AS tokens_total,
       SUM(CASE WHEN error_name IS NOT NULL THEN 1 ELSE 0 END) AS error_count
FROM request_log
WHERE cost_units > 0
  AND account_id IS NOT NULL
  AND started_at_ms >= ? AND started_at_ms <= ?
GROUP BY 1, 2 ORDER BY 1, 2;
```

**Validation**: if `granularity=hour` and the date range exceeds 48 hours, reject with 400.

### 2.3 Store Methods

Extract into a new `src/lib/stats-store.ts` (`request-history.ts` is already 810 lines; SRP favors a dedicated file). The stats store receives the same `Database` instance from `admin-db.ts`.

```typescript
// Write-time upsert (called from request-history.ts insert())
upsertDailyStats(record: { date: string; accountId: string; costUnits: number; tokensTotal: number; hasError: boolean }): void

// Query for day granularity (from daily_premium_stats)
getDailyPremiumStats(params: { from: string; to: string; accountId?: string }): { daily: DailyStats[]; byAccount: DailyAccountStats[] }

// Query for hour granularity (from request_log)
getHourlyPremiumStats(params: { fromMs: number; toMs: number; accountId?: string }): { daily: DailyStats[]; byAccount: DailyAccountStats[] }

// Cleanup
cleanupStatsRetention(retentionDays: number): void
```

`request-history.ts` `insert()` calls `statsStore.upsertDailyStats()` when `costUnits > 0`.

---

## 3. Frontend

### 3.1 Dependencies

Install in `admin-ui/`:
```
recharts
```

No other new dependencies needed. Recharts uses React context and SVG natively.

### 3.2 New Route

In `admin-ui/src/App.tsx`, add between `/requests` and `/models`:

```tsx
<Route path="/statistics" element={<StatisticsPage />} />
```

### 3.3 Navigation

In `admin-ui/src/components/app-shell.tsx`, add sidebar item:

```tsx
{ to: "/statistics", icon: BarChart3, label: t("nav.statistics") }
```

Position: after "Requests", before "Models".

### 3.4 API Client

In `admin-ui/src/lib/admin-api.ts`, add:

```typescript
export async function getAdminPremiumStats(params: {
  from?: string
  to?: string
  accountId?: string
  granularity?: 'day' | 'hour'
}): Promise<PremiumStatsResponse> { ... }
```

### 3.5 Page Layout: `StatisticsPage`

File: `admin-ui/src/pages/statistics-page.tsx`

```
┌─────────────────────────────────────────────────────┐
│  Statistics                                          │
│  ┌───────────────────────────────────────────────┐   │
│  │ [24h] [7d] [本月] [自定义 ▾]    [自动刷新 ▾]  │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │  Total Premium Usage Trend                     │   │
│  │  AreaChart, dual Y-axes                        │   │
│  │  Left Y: cost_units_sum (filled area)          │   │
│  │  Right Y: request_count (dashed line)          │   │
│  │  X: date (or hour for 24h)                     │   │
│  │  Tooltip: date, cost_units, count, tokens      │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │  Per-Account Premium Usage                     │   │
│  │  Stacked AreaChart                             │   │
│  │  Y: cost_units_sum per account                 │   │
│  │  X: date (or hour for 24h)                     │   │
│  │  Each account = one colored area               │   │
│  │  Legend: account list                          │   │
│  │  Tooltip: date, per-account breakdown          │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### 3.6 Chart Components

**`PremiumUsageChart`** (`admin-ui/src/components/charts/premium-usage-chart.tsx`):
- Recharts `ComposedChart` with `Area` (cost_units) + `Line` (request_count)
- Dual `YAxis`: left for cost_units (label: "Cost Units"), right for request count
- `XAxis` dataKey: `date`
- `Tooltip` with custom formatter showing all metrics
- Colors: `--chart-1` for cost_units area, `--chart-2` for count line
- Responsive via `ResponsiveContainer`

**`AccountUsageChart`** (`admin-ui/src/components/charts/account-usage-chart.tsx`):
- Recharts `AreaChart` with stacked `Area` per account
- Transform `by_account` array into pivoted format: `{ date, [account1]: value, [account2]: value, ... }`
- Colors: cycle through `--chart-1` to `--chart-5`, then generate more if needed
- `Legend` showing account names
- `Tooltip` with per-account breakdown
- Responsive via `ResponsiveContainer`

### 3.7 Time Range Controls

Reuse the pattern from `RequestsPage` / `AccountsPage`:

```typescript
type TimePreset = '24h' | '7d' | 'month' | 'custom'

interface TimeRange {
  preset: TimePreset
  from: string   // YYYY-MM-DD
  to: string     // YYYY-MM-DD
}
```

Preset logic:
- `24h`: `granularity=hour`, from = 24h ago, to = now
- `7d`: `granularity=day`, from = 7 days ago, to = today
- `month`: `granularity=day`, from = 1st of current month, to = today
- `custom`: `granularity=day`, user-picked dates

Auto-refresh: 30s / 60s / 5m / off (matches `AccountsPage` pattern).

### 3.8 Internationalization

Add keys to `en-US.json` and `zh-CN.json`:

```json
{
  "nav": { "statistics": "Statistics" / "统计" },
  "statistics": {
    "title": "Statistics" / "统计",
    "premiumUsage": "Premium Usage Trend" / "高级请求用量趋势",
    "accountUsage": "Per-Account Premium Usage" / "各账号高级请求消耗",
    "costUnits": "Cost Units" / "成本单位",
    "requestCount": "Request Count" / "请求次数",
    "tokensTotal": "Total Tokens" / "总 Token 数",
    "errorCount": "Errors" / "错误数",
    "timeRange": { "24h": "24h", "7d": "7 Days" / "7 天", "month": "This Month" / "本月", "custom": "Custom" / "自定义" },
    "noData": "No premium request data for this period" / "该时间段无高级请求数据"
  }
}
```

### 3.9 Theme Integration

Use existing shadcn CSS variables for chart colors:
- `--chart-1` through `--chart-5` already defined in `admin-ui/src/index.css`
- These automatically adapt to light/dark mode via `next-themes`

### 3.10 Empty & Loading States

- **Loading**: Skeleton placeholder matching chart dimensions (Recharts supports this natively)
- **Empty**: Centered message with `statistics.noData` text
- **Error**: Toast via `sonner` on fetch failure, with retry option

---

## 4. File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `src/lib/stats-store.ts` | Daily premium stats store: upsert, query, cleanup |
| `admin-ui/src/pages/statistics-page.tsx` | Statistics page component |
| `admin-ui/src/components/charts/premium-usage-chart.tsx` | Total usage chart |
| `admin-ui/src/components/charts/account-usage-chart.tsx` | Per-account usage chart |

### Modified Files

| File | Changes |
|------|---------|
| `src/lib/admin-db.ts` | Add v9 migration: create `daily_premium_stats` table + backfill |
| `src/lib/request-history.ts` | Call `statsStore.upsertDailyStats()` from `insert()` when `costUnits > 0` |
| `src/routes/admin-api/route.ts` | Add `GET /api/admin/stats/premium-daily` handler |
| `admin-ui/package.json` | Add `recharts` dependency |
| `admin-ui/src/App.tsx` | Add `/statistics` route |
| `admin-ui/src/components/app-shell.tsx` | Add Statistics nav item |
| `admin-ui/src/lib/admin-api.ts` | Add `getAdminPremiumStats()` |
| `admin-ui/src/locales/en-US.json` | Add statistics i18n keys |
| `admin-ui/src/locales/zh-CN.json` | Add statistics i18n keys |

### No Changes Needed

- `src/lib/config.ts` — `statsRetentionDays` can be added to the config schema if desired, but defaulting to 180 in code is sufficient for v1.
- Existing route handlers — write-time aggregation is triggered from `request-history.ts` `insert()`, not from individual route handlers.

---

## 5. Testing Strategy

- **Unit**: Test `upsertDailyStats()` idempotency, `getDailyPremiumStats()` date range filtering, hourly aggregation accuracy.
- **Integration**: Test the full flow: insert a request with `cost_units > 0` → verify `daily_premium_stats` row is created/updated → query API → verify response shape.
- **Migration**: Test v9 migration on a DB with existing `request_log` rows → verify backfill correctness.
- **Frontend**: Manual verification of chart rendering, time range switching, empty states, auto-refresh.
