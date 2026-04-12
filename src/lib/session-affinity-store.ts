import type { Database } from "bun:sqlite"

import consola from "consola"

import { getAdminDb } from "./admin-db"
import { getSessionAffinityRetentionMs } from "./config"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_AGE_MS = 7 * DAY_MS
const CLEANUP_INTERVAL_MS = DAY_MS

const maybeUnref = (timer: ReturnType<typeof setInterval>) => {
  timer.unref()
}

export class SessionAffinityStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  get(cacheKey: string): string | undefined {
    let row: { account_id?: string } | null

    try {
      row = this.db
        .query(
          "SELECT account_id FROM session_affinity WHERE cache_key = ? LIMIT 1;",
        )
        .get(cacheKey) as { account_id?: string } | null
    } catch (error) {
      consola.warn("Failed to read session affinity mapping:", error)
      return undefined
    }

    if (!row?.account_id) {
      return undefined
    }

    try {
      this.db
        .query(
          "UPDATE session_affinity SET last_used_at_ms = ? WHERE cache_key = ?;",
        )
        .run(Date.now(), cacheKey)
    } catch (error) {
      consola.warn("Failed to update session affinity last_used_at_ms:", error)
    }

    return row.account_id
  }

  set(cacheKey: string, accountId: string): void {
    const now = Date.now()

    try {
      this.db
        .query(
          `
          INSERT INTO session_affinity (
            cache_key,
            account_id,
            created_at_ms,
            last_confirmed_at_ms,
            last_used_at_ms
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            account_id = excluded.account_id,
            last_confirmed_at_ms = excluded.last_confirmed_at_ms,
            last_used_at_ms = excluded.last_used_at_ms;
        `,
        )
        .run(cacheKey, accountId, now, now, now)
    } catch (error) {
      consola.warn("Failed to persist session affinity mapping:", error)
    }
  }

  delete(cacheKey: string): void {
    try {
      this.db
        .query("DELETE FROM session_affinity WHERE cache_key = ?;")
        .run(cacheKey)
    } catch (error) {
      consola.warn("Failed to delete session affinity mapping:", error)
    }
  }

  clear(): void {
    try {
      this.db.query("DELETE FROM session_affinity;").run()
    } catch (error) {
      consola.warn("Failed to clear session affinity mappings:", error)
    }
  }

  cleanup(maxAgeMs: number = DEFAULT_MAX_AGE_MS): void {
    try {
      this.db
        .query("DELETE FROM session_affinity WHERE last_used_at_ms < ?;")
        .run(Date.now() - maxAgeMs)
    } catch (error) {
      consola.warn("Failed to cleanup session affinity mappings:", error)
    }
  }
}

let sharedSessionAffinityStore: SessionAffinityStore | null = null
let sharedCleanupInterval: ReturnType<typeof setInterval> | undefined

function clearSharedSessionAffinityCleanup(): void {
  if (!sharedCleanupInterval) {
    return
  }

  clearInterval(sharedCleanupInterval)
  sharedCleanupInterval = undefined
}

export function getSharedSessionAffinityStore(): SessionAffinityStore {
  if (!sharedSessionAffinityStore) {
    sharedSessionAffinityStore = new SessionAffinityStore(getAdminDb())
  }

  return sharedSessionAffinityStore
}

export function applySharedSessionAffinityRetention(
  retentionMs: number = getSessionAffinityRetentionMs(),
): void {
  clearSharedSessionAffinityCleanup()

  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    return
  }

  try {
    const store = getSharedSessionAffinityStore()
    store.cleanup(retentionMs)

    sharedCleanupInterval = setInterval(() => {
      store.cleanup(retentionMs)
    }, CLEANUP_INTERVAL_MS)
    maybeUnref(sharedCleanupInterval)
  } catch (error) {
    consola.warn("Failed to apply session affinity retention:", error)
  }
}
