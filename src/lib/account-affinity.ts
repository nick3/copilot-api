import consola from "consola"

import type { AccountRuntime } from "~/lib/types/account"

export interface AffinityContext {
  requestId?: string
  affinityModelId?: string
}

export interface AffinityPersistenceStore {
  get(key: string): string | undefined
  getMany?(keys: ReadonlyArray<string>): ReadonlyMap<string, string>
  set(key: string, accountId: string): void
  delete(key: string): void
  clear(): void
}

export type AffinityPersistenceStoreProvider =
  | AffinityPersistenceStore
  | (() => AffinityPersistenceStore | undefined)

interface AffinityCacheEntry {
  accountId: string
  expiresAt: number
}

const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * In-memory LRU cache with TTL for account affinity mappings.
 *
 * Uses Map insertion order for LRU eviction: updated or rehydrated entries are
 * deleted and re-inserted so they move to the "newest" end.
 */
export class AccountAffinityCache {
  private readonly cache = new Map<string, AffinityCacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private persistentStore?: AffinityPersistenceStore
  private persistentStoreProvider?: () => AffinityPersistenceStore | undefined

  constructor(
    maxEntries = DEFAULT_MAX_ENTRIES,
    ttlMs = DEFAULT_TTL_MS,
    persistentStore?: AffinityPersistenceStoreProvider,
  ) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs

    if (typeof persistentStore === "function") {
      this.persistentStoreProvider = persistentStore
    } else {
      this.persistentStore = persistentStore
    }
  }

  /** Look up the preferred account ID for a cache key. Returns undefined if not found or expired. */
  get(key: string): string | undefined {
    const entry = this.cache.get(key)
    if (entry) {
      if (Date.now() >= entry.expiresAt) {
        this.cache.delete(key)
      } else {
        return entry.accountId
      }
    }

    const accountId = this.readPersistentEntry(key)
    if (!accountId) {
      return undefined
    }

    this.setMemory(key, accountId)
    return accountId
  }

  getMany(keys: ReadonlyArray<string>): ReadonlyMap<string, string> {
    const result = new Map<string, string>()
    const missingKeys = new Array<string>()
    const now = Date.now()

    for (const key of keys) {
      if (result.has(key)) {
        continue
      }

      const entry = this.cache.get(key)
      if (!entry) {
        missingKeys.push(key)
        continue
      }

      if (now >= entry.expiresAt) {
        this.cache.delete(key)
        missingKeys.push(key)
        continue
      }

      result.set(key, entry.accountId)
    }

    if (missingKeys.length === 0) {
      return result
    }

    const persistentEntries = this.readPersistentEntries(missingKeys)
    for (const [key, accountId] of persistentEntries) {
      this.setMemory(key, accountId)
    }

    if (result.size === 0) {
      return persistentEntries
    }

    for (const [key, accountId] of persistentEntries) {
      result.set(key, accountId)
    }

    return result
  }

  /** Record a successful account mapping. Refreshes TTL and moves the entry to the newest position. */
  set(key: string, accountId: string): void {
    this.setMemory(key, accountId)
    this.writePersistentEntry(key, accountId)
  }

  /** Remove a specific entry. */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key)
    this.deletePersistentEntry(key)
    return deleted
  }

  /** Remove all in-memory entries. */
  clearMemory(): void {
    this.cache.clear()
  }

  /** Remove all entries. */
  clear(): void {
    this.clearMemory()
    this.clearPersistentEntries()
  }

  /** Current number of entries (including potentially expired ones). */
  get size(): number {
    return this.cache.size
  }

  private getPersistentStore(
    options: { throwOnProviderFailure?: boolean } = {},
  ): AffinityPersistenceStore | undefined {
    if (this.persistentStore) {
      return this.persistentStore
    }
    if (!this.persistentStoreProvider) {
      return undefined
    }

    try {
      const store = this.persistentStoreProvider()
      if (store) {
        this.persistentStore = store
      }
      return store
    } catch (error) {
      if (options.throwOnProviderFailure) {
        consola.error("Failed to resolve affinity persistence store:", error)
        throw new Error("Affinity persistence store provider failed")
      }

      consola.warn("Failed to resolve affinity persistence store:", error)
      return undefined
    }
  }

  private readPersistentEntry(key: string): string | undefined {
    const store = this.getPersistentStore()
    if (!store) {
      return undefined
    }

    try {
      return store.get(key)
    } catch (error) {
      consola.warn(
        "Failed to read affinity mapping from persistent store:",
        error,
      )
      return undefined
    }
  }

  private readPersistentEntries(
    keys: ReadonlyArray<string>,
  ): ReadonlyMap<string, string> {
    const store = this.getPersistentStore({ throwOnProviderFailure: true })
    if (!store) {
      return new Map()
    }

    if (store.getMany) {
      try {
        return store.getMany(keys)
      } catch (error) {
        consola.warn(
          "Failed to batch-read affinity mappings from persistent store:",
          error,
        )
        throw new Error(
          `Affinity persistent store batch lookup failed for ${keys.length} keys`,
        )
      }
    }

    const result = new Map<string, string>()
    const failedKeys = new Array<string>()
    for (const key of keys) {
      try {
        const accountId = store.get(key)
        if (accountId) {
          result.set(key, accountId)
        }
      } catch (error) {
        failedKeys.push(key)
        consola.warn(
          "Failed to read affinity mapping from persistent store:",
          error,
        )
      }
    }

    if (failedKeys.length > 0) {
      throw new Error(
        `Affinity persistent store lookup failed for ${failedKeys.length}/${keys.length} keys`,
      )
    }

    return result
  }

  private writePersistentEntry(key: string, accountId: string): void {
    const store = this.getPersistentStore()
    if (!store) {
      return
    }

    try {
      store.set(key, accountId)
    } catch (error) {
      consola.warn("Failed to persist affinity mapping:", error)
    }
  }

  private deletePersistentEntry(key: string): void {
    const store = this.getPersistentStore()
    if (!store) {
      return
    }

    try {
      store.delete(key)
    } catch (error) {
      consola.warn("Failed to delete affinity mapping:", error)
    }
  }

  private clearPersistentEntries(): void {
    const store = this.getPersistentStore()
    if (!store) {
      return
    }

    try {
      store.clear()
    } catch (error) {
      consola.warn("Failed to clear persistent affinity mappings:", error)
    }
  }

  private setMemory(key: string, accountId: string): void {
    // Delete first so re-insertion moves it to the newest position (LRU).
    this.cache.delete(key)

    // Evict oldest entries if at capacity.
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }

    this.cache.set(key, {
      accountId,
      expiresAt: Date.now() + this.ttlMs,
    })
  }
}

/**
 * Extract the affinity key from the request context.
 * Uses the upstream request ID which is deterministic for the same user message.
 */
export function extractAffinityKey(
  context: AffinityContext,
): string | undefined {
  return context.requestId?.trim() || undefined
}

/**
 * Build the full cache key by combining the affinity key with the model ID.
 * This prevents cross-model pollution (same session requesting different models
 * can be routed to different accounts).
 */
export function buildAffinityCacheKey(
  affinityKey: string,
  modelId: string,
): string {
  return `${affinityKey}:${modelId}`
}

/**
 * Check whether an account is a valid affinity candidate.
 * An account is valid if it is not failed and is present in the provided
 * runtime list.
 */
export function isAffinityAccountUsable(
  accountId: string,
  accounts: ReadonlyArray<AccountRuntime>,
): AccountRuntime | undefined {
  const account = accounts.find((a) => a.id === accountId)
  if (!account) return undefined
  if (account.failed) return undefined
  return account
}
