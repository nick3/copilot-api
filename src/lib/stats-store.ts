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

  getDailyPremiumStats(params: {
    from: string
    to: string
    accountId?: string
  }): { daily: Array<DailyStats>; byAccount: Array<DailyAccountStats> } {
    const accountFilter = params.accountId ? " AND account_id = ?" : ""
    const args: Array<string | number> = [params.from, params.to]
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
      .all(...args) as Array<DailyStats>

    const byAccount = this.db
      .query(
        `SELECT date, account_id, request_count, cost_units_sum, tokens_total, error_count
         FROM daily_premium_stats
         WHERE date >= ? AND date <= ?${accountFilter}
         ORDER BY date, account_id`,
      )
      .all(...args) as Array<DailyAccountStats>

    return { daily, byAccount }
  }

  getHourlyPremiumStats(params: {
    fromMs: number
    toMs: number
    accountId?: string
  }): { daily: Array<DailyStats>; byAccount: Array<DailyAccountStats> } {
    const accountFilter = params.accountId ? " AND account_id = ?" : ""
    const dailyArgs: Array<string | number> = [params.fromMs, params.toMs]
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
      .all(...dailyArgs) as Array<DailyStats>

    const byAccountFilter =
      params.accountId ? " AND account_id = ?" : " AND account_id IS NOT NULL"
    const byAccountArgs: Array<string | number> = [params.fromMs, params.toMs]
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
         WHERE cost_units > 0
           AND started_at_ms >= ? AND started_at_ms <= ?${byAccountFilter}
         GROUP BY 1, 2
         ORDER BY 1, 2`,
      )
      .all(...byAccountArgs) as Array<DailyAccountStats>

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
