# Persistent Session Affinity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `affinity cache key` 真正承担“同一 agent 会话必须回到同一上游 Copilot 账号”的职责：绑定跨进程重启、跨数小时空闲仍然有效，只有账号明确不可服务时才回退到现有 miss/轮转逻辑。

**Architecture:** 保留现有 `AccountAffinityCache` 作为 L1 内存热缓存，但把它改成可选持久化后端的 read-through / write-through 两层结构。新增 `session_affinity` SQLite 表和 `SessionAffinityStore` 作为 L2 持久化绑定，`AccountsManager` 在 affinity 选择阶段优先读取它，并在 owner 不可服务时主动清理陈旧绑定，再回退到当前 quota/轮转路径。

**Tech Stack:** TypeScript、Bun (`bun:sqlite`)、Bun test、现有 `accounts-manager`/`admin.sqlite` 迁移体系

**Git note:** 本计划故意省略 commit 步骤。只有在用户明确要求时才创建 git commit。

---

## File map

### New files
- `src/lib/session-affinity-store.ts` — `session_affinity` 的 SQLite 读写、共享实例和过期清理逻辑
- `tests/session-affinity-store.test.ts` — migration + store 行为的 focused 回归测试
- `tests/accounts-manager-session-affinity.test.ts` — `AccountsManager` 对持久化 session binding 的选择行为回归测试

### Modified files
- `src/lib/admin-db.ts` — 新增 v8 migration，创建 `session_affinity` 表与索引
- `src/lib/account-affinity.ts` — 给 `AccountAffinityCache` 增加持久化后端、`clearMemory()`，并保持现有 key/helper API 不变
- `src/lib/accounts-manager.ts` — 注入持久化 affinity store，在 preferred account 不可服务时删除 stale binding，并在 shutdown 时只清空 L1
- `tests/account-affinity-cache.test.ts` — 覆盖 L2 回填、write-through、`clearMemory()` vs `clear()` 的行为
- `tests/accounts-manager-test-helpers.ts` — 允许测试注入自定义 persistent affinity store

### Leave untouched unless a task proves otherwise
- `src/routes/messages/handler.ts`
- `src/routes/responses/handler.ts`
- `src/routes/chat-completions/handler.ts`
- `src/lib/request-history.ts`
- `src/lib/session-ownership.ts`

---

## Task 1: Add durable session-affinity storage and schema migration

**Files:**
- Create: `src/lib/session-affinity-store.ts`
- Modify: `src/lib/admin-db.ts`
- Create: `tests/session-affinity-store.test.ts`

- [ ] **Step 1: Add failing tests for the v8 migration and the new store API**

```ts
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { getAdminDbUserVersion, initAdminDb } from "../src/lib/admin-db"
import { SessionAffinityStore } from "../src/lib/session-affinity-store"

test("initAdminDb creates session_affinity at user_version 8", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(getAdminDbUserVersion(db)).toBe(8)

  const columns = db
    .query("PRAGMA table_info(session_affinity);")
    .all() as Array<{ name: string }>

  expect(columns.map((column) => column.name)).toEqual([
    "cache_key",
    "account_id",
    "created_at_ms",
    "last_confirmed_at_ms",
    "last_used_at_ms",
  ])
})

test("SessionAffinityStore set/get round-trips the persisted account", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  store.set("session-1:gpt-5.4", "acct-a")

  expect(store.get("session-1:gpt-5.4")).toBe("acct-a")

  const row = db
    .query(
      "SELECT account_id, created_at_ms, last_confirmed_at_ms, last_used_at_ms FROM session_affinity WHERE cache_key = ? LIMIT 1;",
    )
    .get("session-1:gpt-5.4") as {
    account_id: string
    created_at_ms: number
    last_confirmed_at_ms: number
    last_used_at_ms: number
  } | null

  expect(row?.account_id).toBe("acct-a")
  expect(row?.created_at_ms).toBeTypeOf("number")
  expect(row?.last_confirmed_at_ms).toBeTypeOf("number")
  expect(row?.last_used_at_ms).toBeTypeOf("number")
})

test("SessionAffinityStore cleanup removes stale rows by last_used_at_ms", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  store.set("stale:gpt-5.4", "acct-old")
  db.query(
    "UPDATE session_affinity SET last_used_at_ms = ? WHERE cache_key = ?;",
  ).run(Date.now() - 10_000, "stale:gpt-5.4")

  store.cleanup(1_000)

  expect(store.get("stale:gpt-5.4")).toBeUndefined()
})
```

- [ ] **Step 2: Run the focused store tests and verify they fail first**

Run:

```bash
bun test "tests/session-affinity-store.test.ts"
```

Expected:
- FAIL because `SessionAffinityStore` does not exist yet
- FAIL because `admin-db` still reports `user_version = 7`

- [ ] **Step 3: Implement the new SQLite-backed store and v8 migration**

```ts
// src/lib/admin-db.ts (append after the current v7 migration block)
if (current < 8) {
  db.run(`
    CREATE TABLE IF NOT EXISTS session_affinity (
      cache_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      last_confirmed_at_ms INTEGER NOT NULL,
      last_used_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_affinity_last_used
      ON session_affinity(last_used_at_ms);

    CREATE INDEX IF NOT EXISTS idx_session_affinity_account
      ON session_affinity(account_id);

    PRAGMA user_version = 8;
  `)
}
```

```ts
// src/lib/session-affinity-store.ts
import type { Database } from "bun:sqlite"

import { getAdminDb } from "./admin-db"

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export class SessionAffinityStore {
  constructor(private readonly db: Database) {}

  get(cacheKey: string): string | undefined {
    const row = this.db
      .query(
        "SELECT account_id FROM session_affinity WHERE cache_key = ? LIMIT 1;",
      )
      .get(cacheKey) as { account_id?: string } | null

    if (!row?.account_id) {
      return undefined
    }

    this.db
      .query(
        "UPDATE session_affinity SET last_used_at_ms = ? WHERE cache_key = ?;",
      )
      .run(Date.now(), cacheKey)

    return row.account_id
  }

  set(cacheKey: string, accountId: string): void {
    const now = Date.now()
    this.db
      .query(`
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
      `)
      .run(cacheKey, accountId, now, now, now)
  }

  delete(cacheKey: string): void {
    this.db
      .query("DELETE FROM session_affinity WHERE cache_key = ?;")
      .run(cacheKey)
  }

  clear(): void {
    this.db.query("DELETE FROM session_affinity;").run()
  }

  cleanup(maxAgeMs: number = DEFAULT_MAX_AGE_MS): void {
    this.db
      .query("DELETE FROM session_affinity WHERE last_used_at_ms < ?;")
      .run(Date.now() - maxAgeMs)
  }
}

let sharedSessionAffinityStore: SessionAffinityStore | null = null

export function getSharedSessionAffinityStore(): SessionAffinityStore {
  if (!sharedSessionAffinityStore) {
    sharedSessionAffinityStore = new SessionAffinityStore(getAdminDb())
  }

  return sharedSessionAffinityStore
}
```

- [ ] **Step 4: Re-run the store tests and verify the green state**

Run:

```bash
bun test "tests/session-affinity-store.test.ts"
```

Expected:
- PASS for the migration/user_version assertion
- PASS for round-trip persistence and stale-row cleanup

---

## Task 2: Turn AccountAffinityCache into a two-tier cache

**Files:**
- Modify: `src/lib/account-affinity.ts`
- Modify: `tests/account-affinity-cache.test.ts`

- [ ] **Step 1: Add failing tests for persistent read-through, write-through, and memory-only clears**

```ts
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { initAdminDb } from "../src/lib/admin-db"
import { AccountAffinityCache } from "../src/lib/account-affinity"
import { SessionAffinityStore } from "../src/lib/session-affinity-store"

test("get hydrates memory from the persistent store on L1 miss", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)
  store.set("session-2:gpt-5.4", "acct-b")

  const cache = new AccountAffinityCache(100, 60_000, store)

  expect(cache.get("session-2:gpt-5.4")).toBe("acct-b")
  expect(cache.size).toBe(1)
})

test("set writes through to the persistent store", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)
  const cache = new AccountAffinityCache(100, 60_000, store)

  cache.set("session-3:gpt-5.4", "acct-c")

  expect(store.get("session-3:gpt-5.4")).toBe("acct-c")
})

test("clearMemory keeps the persistent binding while clear removes both tiers", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)
  const cache = new AccountAffinityCache(100, 60_000, store)

  cache.set("session-4:gpt-5.4", "acct-d")
  cache.clearMemory()

  expect(cache.size).toBe(0)
  expect(store.get("session-4:gpt-5.4")).toBe("acct-d")

  cache.clear()

  expect(store.get("session-4:gpt-5.4")).toBeUndefined()
})
```

- [ ] **Step 2: Run the cache tests and confirm the new cases fail first**

Run:

```bash
bun test "tests/account-affinity-cache.test.ts"
```

Expected:
- FAIL because `AccountAffinityCache` does not accept a persistent store yet
- FAIL because `clearMemory()` does not exist

- [ ] **Step 3: Implement read-through/write-through semantics without changing the existing key helpers**

```ts
// src/lib/account-affinity.ts
export interface AffinityPersistenceStore {
  get(key: string): string | undefined
  set(key: string, accountId: string): void
  delete(key: string): void
  clear(): void
}

export class AccountAffinityCache {
  private readonly cache = new Map<string, AffinityCacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly persistentStore?: AffinityPersistenceStore

  constructor(
    maxEntries = DEFAULT_MAX_ENTRIES,
    ttlMs = DEFAULT_TTL_MS,
    persistentStore?: AffinityPersistenceStore,
  ) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.persistentStore = persistentStore
  }

  get(key: string): string | undefined {
    const entry = this.cache.get(key)
    if (entry) {
      if (Date.now() >= entry.expiresAt) {
        this.cache.delete(key)
      } else {
        return entry.accountId
      }
    }

    const persistedAccountId = this.persistentStore?.get(key)
    if (!persistedAccountId) {
      return undefined
    }

    this.setMemory(key, persistedAccountId)
    return persistedAccountId
  }

  set(key: string, accountId: string): void {
    this.setMemory(key, accountId)
    this.persistentStore?.set(key, accountId)
  }

  delete(key: string): boolean {
    const deleted = this.cache.delete(key)
    this.persistentStore?.delete(key)
    return deleted
  }

  clearMemory(): void {
    this.cache.clear()
  }

  clear(): void {
    this.cache.clear()
    this.persistentStore?.clear()
  }

  private setMemory(key: string, accountId: string): void {
    this.cache.delete(key)

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
```

- [ ] **Step 4: Re-run the cache tests and verify the two-tier behavior is green**

Run:

```bash
bun test "tests/account-affinity-cache.test.ts"
```

Expected:
- PASS for all existing TTL/LRU tests
- PASS for persistent hydration and `clearMemory()` semantics

---

## Task 3: Wire persistent session affinity into AccountsManager

**Files:**
- Modify: `src/lib/accounts-manager.ts`
- Modify: `tests/accounts-manager-test-helpers.ts`
- Create: `tests/accounts-manager-session-affinity.test.ts`

- [ ] **Step 1: Add failing tests for persisted owner hits and stale-binding fallback**

```ts
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { buildAffinityCacheKey } from "../src/lib/account-affinity"
import { initAdminDb } from "../src/lib/admin-db"
import { SessionAffinityStore } from "../src/lib/session-affinity-store"
import {
  makeModel,
  makeModelsResponse,
  setupManager,
} from "./accounts-manager-test-helpers"

test("selectAccountForRequest honors a persisted session binding after a fresh manager starts", async () => {
  const model = makeModel({ id: "gpt-5.4" })
  const a = {
    id: "acct-a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b = {
    id: "acct-b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)
  store.set(buildAffinityCacheKey("stable-session", "gpt-5.4"), "acct-b")

  const manager = setupManager([a, b], {
    persistentAffinityStore: store,
  })

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "gpt-5.4", endpoint: "/responses" }],
    { requestId: "stable-session" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("acct-b")
  expect(selection.affinityHit).toBe(true)
  expect(selection.selectionReason).toBe("affinity_hit")
})

test("stale persisted binding is purged before falling back to normal selection", async () => {
  const model = makeModel({ id: "gpt-5.4" })
  const only = {
    id: "acct-live",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_live",
    models: makeModelsResponse([model]),
  }

  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)
  const cacheKey = buildAffinityCacheKey("stable-session", "gpt-5.4")
  store.set(cacheKey, "acct-missing")

  const manager = setupManager([only], {
    persistentAffinityStore: store,
  })

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "gpt-5.4", endpoint: "/responses" }],
    { requestId: "stable-session" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("acct-live")
  expect(store.get(cacheKey)).toBeUndefined()
})
```

- [ ] **Step 2: Run the manager-focused tests and verify the new cases fail first**

Run:

```bash
bun test "tests/accounts-manager-session-affinity.test.ts"
```

Expected:
- FAIL because `AccountsManager` cannot accept an injected persistent store yet
- FAIL because stale bindings are not purged before fallback

- [ ] **Step 3: Inject the shared store into AccountsManager and keep shutdown semantics correct**

```ts
// tests/accounts-manager-test-helpers.ts
import type { AffinityPersistenceStore } from "../src/lib/account-affinity"

export const setupManager = (
  accounts: Array<AccountRuntime>,
  options?: {
    temporaryAccount?: AccountRuntime
    persistentAffinityStore?: AffinityPersistenceStore
  },
): AccountsManager => {
  const manager = new AccountsManager({
    persistentAffinityStore: options?.persistentAffinityStore,
  })
  const internals = manager as unknown as {
    accounts: Map<string, AccountRuntime>
    accountOrder: Array<string>
    temporaryAccount?: AccountRuntime
  }

  for (const account of accounts) {
    internals.accounts.set(account.id, account)
    internals.accountOrder.push(account.id)
  }

  if (options?.temporaryAccount) {
    internals.temporaryAccount = options.temporaryAccount
  }

  return manager
}
```

```ts
// src/lib/accounts-manager.ts
import {
  AccountAffinityCache,
  buildAffinityCacheKey,
  extractAffinityKey,
  isAffinityAccountUsable,
  type AffinityContext,
  type AffinityPersistenceStore,
} from "~/lib/account-affinity"
import { getSharedSessionAffinityStore } from "./session-affinity-store"

export class AccountsManager {
  private affinityCache: AccountAffinityCache
  private sessionOwnership = new SessionOwnershipCache()

  constructor(options?: {
    persistentAffinityStore?: AffinityPersistenceStore
  }) {
    this.affinityCache = new AccountAffinityCache(
      undefined,
      undefined,
      options?.persistentAffinityStore ?? getSharedSessionAffinityStore(),
    )
  }

  setAccountAffinityEnabled(enabled: boolean): void {
    this.accountAffinityEnabled = enabled
    if (!enabled) {
      this.affinityCache.clear()
    }
  }

  private async selectPreferredAffinityAccount(params: {
    cacheKey: string | undefined
    orderedAccounts: Array<AccountRuntime>
    candidates: Array<AccountRequestCandidate>
    initialSelectionReason: AccountSelectionReason
  }): Promise<{
    result?: SelectAccountForRequestSuccess
    selectionReason: AccountSelectionReason
    affinityCacheMiss: boolean
  }> {
    const { cacheKey, orderedAccounts, candidates, initialSelectionReason } =
      params

    if (!cacheKey) {
      return {
        selectionReason: initialSelectionReason,
        affinityCacheMiss: false,
      }
    }

    const preferredId = this.affinityCache.get(cacheKey)
    if (!preferredId) {
      return {
        selectionReason: initialSelectionReason,
        affinityCacheMiss: true,
      }
    }

    const affinityResult = await this.tryAffinityAccount(
      preferredId,
      orderedAccounts,
      candidates,
    )
    if (!affinityResult) {
      this.affinityCache.delete(cacheKey)
      return {
        selectionReason: preserveSubagentSelectionReason(
          initialSelectionReason,
          "preferred_account_unavailable",
        ),
        affinityCacheMiss: false,
      }
    }

    const selectionReason = preserveSubagentSelectionReason(
      initialSelectionReason,
      "affinity_hit",
    )
    affinityResult.affinityHit = true
    affinityResult.affinityCacheKey = cacheKey
    affinityResult.selectionReason = selectionReason
    affinityResult.confirmAffinity = () => {
      if (!this.accountAffinityEnabled) return
      this.affinityCache.set(cacheKey, affinityResult.account.id)
    }

    return {
      result: affinityResult,
      selectionReason,
      affinityCacheMiss: false,
    }
  }

  shutdown(): void {
    this.sessionOwnershipGeneration++
    this.stopRegistryWatcher()
    this.stopAllTokenRefresh()
    this.stopAllSessionRefresh()
    this.stopModelsRefresh()
    this.affinityCache.clearMemory()
    this.sessionOwnership.clear()
    this.loadBalanceCursor = 0
    this.accounts.clear()
    this.accountOrder = []
    this.temporaryAccount = undefined
  }
}
```

- [ ] **Step 4: Run the end-to-end affinity tests and verify persisted bindings survive a fresh manager**

Run:

```bash
bun test "tests/session-affinity-store.test.ts" "tests/account-affinity-cache.test.ts" "tests/accounts-manager-session-affinity.test.ts"
```

Expected:
- PASS for durable binding lookup after a fresh `AccountsManager` is constructed
- PASS for stale-binding purge before fallback
- PASS for `clearMemory()` preserving the persisted row while `shutdown()` only drops L1

---

## Final verification checklist

- [ ] Run the complete targeted regression set:

```bash
bun test "tests/session-affinity-store.test.ts" "tests/account-affinity-cache.test.ts" "tests/accounts-manager-session-affinity.test.ts"
```

Expected:
- All three files PASS
- No changes required in route handlers because `AccountsManager.selectAccountForRequest()` keeps the same public contract

- [ ] Spot-check that the example failure mode is prevented conceptually:

```text
1. Request A succeeds on account nick3github and calls confirmAffinity()
2. Process restarts or 7+ hours pass
3. Request B arrives with the same affinity cache key
4. L1 misses, L2 session_affinity returns nick3github
5. AccountsManager records affinity_hit and keeps the same account
6. No ownership mismatch retry fan-out occurs
```

- [ ] Leave `selection_reason` / logging schema unchanged in this implementation pass.

Reason:
- The functional bug is the missing durable binding, not the logging layout.
- Logging improvements can be a follow-up once the routing invariant is restored.
