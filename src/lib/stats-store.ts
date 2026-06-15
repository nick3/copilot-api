import type { Database } from "bun:sqlite"

import { consola } from "consola"

export interface DailyStats {
  date: string
  request_count: number
  premium_consumed: number
  credits_consumed: number
  tokens_total: number
  error_count: number
}

export interface DailyAccountStats extends DailyStats {
  account_id: string
}

export interface PremiumStatsResponse {
  daily: Array<DailyStats>
  by_account: Array<DailyAccountStats>
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
      record.tokensTotal,
      record.hasError ? 1 : 0,
      Date.now(),
    )
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

  getConsumptionFromSnapshots(params: {
    fromMs: number
    toMs: number
    granularity: "day" | "hour"
    accountId?: string
  }): Array<{ date: string; account_id: string; premium_consumed: number }> {
    const dateExpr =
      params.granularity === "hour" ?
        "strftime('%Y-%m-%dT%H:00:00Z', snapshot_at_ms / 1000, 'unixepoch')"
      : "date(snapshot_at_ms / 1000, 'unixepoch', 'localtime')"

    const accountFilter = params.accountId ? " AND account_id = ?" : ""
    const args: Array<string | number> = []

    // baseline CTE: WHERE snapshot_at_ms < ?
    args.push(params.fromMs)
    // baseline CTE: AND account_id = ? (if filtered)
    if (params.accountId) args.push(params.accountId)

    // all_snaps CTE: WHERE snapshot_at_ms >= ? AND snapshot_at_ms <= ?
    args.push(params.fromMs, params.toMs)
    // all_snaps CTE: AND account_id = ? (if filtered)
    if (params.accountId) args.push(params.accountId)

    // outer WHERE: snapshot_at_ms >= ?
    args.push(params.fromMs)

    return this.db
      .query(
        `WITH baseline AS (
          SELECT qs.account_id, qs.snapshot_at_ms, qs.remaining, qs.id
          FROM quota_snapshots qs
          INNER JOIN (
            SELECT account_id, MAX(snapshot_at_ms) AS max_ts
            FROM quota_snapshots
            WHERE snapshot_at_ms < ?
              AND unlimited = 0${accountFilter}
            GROUP BY account_id
          ) latest ON qs.account_id = latest.account_id
                  AND qs.snapshot_at_ms = latest.max_ts
        ),
        all_snaps AS (
          SELECT account_id, snapshot_at_ms, remaining, id
          FROM baseline
          UNION ALL
          SELECT account_id, snapshot_at_ms, remaining, id
          FROM quota_snapshots
          WHERE snapshot_at_ms >= ? AND snapshot_at_ms <= ?
            AND unlimited = 0${accountFilter}
        ),
        with_prev AS (
          SELECT
            account_id,
            snapshot_at_ms,
            remaining,
            LAG(remaining) OVER (
              PARTITION BY account_id ORDER BY snapshot_at_ms, id
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
      .all(...args) as Array<{
      date: string
      account_id: string
      premium_consumed: number
    }>
  }

  getDailyPremiumStats(params: {
    from: string
    to: string
    accountId?: string
  }): { daily: Array<DailyStats>; byAccount: Array<DailyAccountStats> } {
    const accountFilter = params.accountId ? " AND account_id = ?" : ""
    const args: Array<string | number> = [params.from, params.to]
    if (params.accountId) args.push(params.accountId)

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

    const fromMs = this.localDateToMs(params.from)
    const toMs = this.localDateEndMs(params.to)

    const consumption = this.getConsumptionFromSnapshots({
      fromMs,
      toMs,
      granularity: "day",
      accountId: params.accountId,
    })

    return this.mergeMetricsAndConsumption(
      dailyMetrics,
      byAccountMetrics,
      consumption,
    )
  }

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
        `SELECT strftime('%Y-%m-%dT%H:00:00Z', started_at_ms / 1000, 'unixepoch') AS date,
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
        `SELECT strftime('%Y-%m-%dT%H:00:00Z', started_at_ms / 1000, 'unixepoch') AS date,
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

    const consumption = this.getConsumptionFromSnapshots({
      fromMs: params.fromMs,
      toMs: params.toMs,
      granularity: "hour",
      accountId: params.accountId,
    })

    return this.mergeMetricsAndConsumption(
      dailyMetrics,
      byAccountMetrics,
      consumption,
    )
  }

  cleanupStatsRetention(
    retentionDays: number = DEFAULT_STATS_RETENTION_DAYS,
  ): void {
    try {
      const nowMs = Date.now()
      const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000
      const cutoffDate = toLocalDateString(cutoffMs)
      this.db
        .query("DELETE FROM daily_premium_stats WHERE date < ?;")
        .run(cutoffDate)

      // Keep the latest snapshot per account before the cutoff as baseline
      // for getConsumptionFromSnapshots() which needs a pre-range reference.
      this.db
        .query(
          `DELETE FROM quota_snapshots
           WHERE snapshot_at_ms < ?
             AND id NOT IN (
               SELECT qs.id
               FROM quota_snapshots qs
               INNER JOIN (
                 SELECT account_id, MAX(snapshot_at_ms) AS max_ts
                 FROM quota_snapshots
                 WHERE snapshot_at_ms < ?
                 GROUP BY account_id
               ) latest ON qs.account_id = latest.account_id
                        AND qs.snapshot_at_ms = latest.max_ts
             );`,
        )
        .run(cutoffMs, cutoffMs)
    } catch (error) {
      consola.debug("Failed to cleanup stats retention", error)
    }
  }

  private localDateToMs(dateStr: string): number {
    const [y, m, d] = dateStr.split("-").map(Number)
    return new Date(y, m - 1, d).getTime()
  }

  /** End-of-day ms (next local midnight - 1ms), DST-safe. */
  private localDateEndMs(dateStr: string): number {
    const [y, m, d] = dateStr.split("-").map(Number)
    return new Date(y, m - 1, d + 1).getTime() - 1
  }

  private mergeMetricsAndConsumption(
    dailyMetrics: Array<{
      date: string
      request_count: number
      tokens_total: number
      error_count: number
    }>,
    byAccountMetrics: Array<{
      date: string
      account_id: string
      request_count: number
      tokens_total: number
      error_count: number
    }>,
    consumption: Array<{
      date: string
      account_id: string
      premium_consumed: number
    }>,
  ): { daily: Array<DailyStats>; byAccount: Array<DailyAccountStats> } {
    const consumptionMap = new Map<string, number>()
    const dateConsumptionMap = new Map<string, number>()
    for (const c of consumption) {
      consumptionMap.set(`${c.date}|${c.account_id}`, c.premium_consumed)
      dateConsumptionMap.set(
        c.date,
        (dateConsumptionMap.get(c.date) ?? 0) + c.premium_consumed,
      )
    }

    const allDates = new Set([
      ...dailyMetrics.map((m) => m.date),
      ...consumption.map((c) => c.date),
    ])
    const metricsMap = new Map(dailyMetrics.map((m) => [m.date, m]))

    const daily: Array<DailyStats> = [...allDates].sort().map((date) => {
      const m = metricsMap.get(date)
      const creditsConsumed = dateConsumptionMap.get(date) ?? 0
      return {
        date,
        request_count: m?.request_count ?? 0,
        premium_consumed: creditsConsumed,
        credits_consumed: creditsConsumed,
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
        const creditsConsumed = consumptionMap.get(key) ?? 0
        return {
          date,
          account_id,
          request_count: m?.request_count ?? 0,
          premium_consumed: creditsConsumed,
          credits_consumed: creditsConsumed,
          tokens_total: m?.tokens_total ?? 0,
          error_count: m?.error_count ?? 0,
        }
      })

    return { daily, byAccount }
  }
}
