import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import { buildAffinityCacheKey } from "../src/lib/account-affinity"
import { initAdminDb } from "../src/lib/admin-db"
import { SessionAffinityStore } from "../src/lib/session-affinity-store"
import { buildResponsesItemOwnershipKey } from "../src/routes/messages/responses-item-ownership"
import {
  makeModel,
  makeModelsResponse,
  setupManager,
} from "./accounts-manager-test-helpers"

// ---------------------------------------------------------------------------
// Persistent session affinity via AccountsManager
// ---------------------------------------------------------------------------

test("persistent affinity: pre-written binding routes to the same account on fresh manager", async () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  const model = makeModel({ id: "free-model" })
  const cacheKey = buildAffinityCacheKey("session-1", "free-model")

  const accountA: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const accountB: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  // Pre-seed the persistent store with a binding to account "b".
  store.set(cacheKey, "b")

  const manager = setupManager([accountA, accountB], {
    persistentAffinityStore: store,
  })

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-1" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("b")
  expect(selection.affinityHit).toBe(true)
  expect(selection.selectionReason).toBe("affinity_hit")
})

test("responses item ownership routes before ordinary session affinity", async () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  const model = makeModel({ id: "free-model" })
  const affinityKey = buildAffinityCacheKey("session-1", "free-model")
  const ownerKey = buildResponsesItemOwnershipKey("id", "rs_owner")

  const accountA: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const accountB: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  store.set(affinityKey, "a")
  store.set(ownerKey, "b")

  const manager = setupManager([accountA, accountB], {
    persistentAffinityStore: store,
  })

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    {
      requestId: "session-1",
      responsesItemOwnershipKeys: [ownerKey],
    },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("b")
  expect(selection.affinityHit).toBe(true)
  expect(selection.affinityCacheKey).toBe(ownerKey)
  expect(selection.selectionReason).toBe("responses_item_owner_hit")
})

test("persistent affinity: stale binding pointing to unavailable account is purged and falls back", async () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  const model = makeModel({ id: "free-model" })
  const cacheKey = buildAffinityCacheKey("session-stale", "free-model")

  // Pre-seed with a non-existent account.
  store.set(cacheKey, "ghost-account")

  const accountA: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([accountA], { persistentAffinityStore: store })

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-stale" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("a")
  expect(selection.selectionReason).toBe("preferred_account_unavailable")

  // The stale binding should be purged from the persistent store.
  expect(store.get(cacheKey)).toBeUndefined()
})

test("persistent affinity: shutdown clears L1 but preserves L2, fresh manager still hits", async () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  const model = makeModel({ id: "free-model" })

  const accountA: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const accountB: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  // Phase 1: First manager selects and confirms affinity.
  const manager1 = setupManager([accountA, accountB], {
    persistentAffinityStore: store,
  })

  const first = await manager1.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-lifecycle" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.account.id).toBe("a")
  first.confirmAffinity?.()

  // Verify store has the binding.
  const cacheKey = buildAffinityCacheKey("session-lifecycle", "free-model")
  expect(store.get(cacheKey)).toBe("a")

  // Shutdown clears L1 in-memory but not L2 persistent.
  manager1.shutdown()

  // Phase 2: Fresh manager with same store should still hit via L2.
  const manager2 = setupManager([{ ...accountA }, { ...accountB }], {
    persistentAffinityStore: store,
  })

  const second = await manager2.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-lifecycle" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return

  expect(second.account.id).toBe("a")
  expect(second.affinityHit).toBe(true)
  expect(second.selectionReason).toBe("affinity_hit")
})

test("persistent affinity: disabling affinity clears only L1 and preserves L2", async () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new SessionAffinityStore(db)

  const model = makeModel({ id: "free-model" })
  const cacheKey = buildAffinityCacheKey("session-disabled", "free-model")

  const accountA: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const accountB: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([accountA, accountB], {
    persistentAffinityStore: store,
  })

  const first = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-disabled" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  first.confirmAffinity?.()

  expect(store.get(cacheKey)).toBe("a")

  manager.setAccountAffinityEnabled(false)

  expect(store.get(cacheKey)).toBe("a")
})
