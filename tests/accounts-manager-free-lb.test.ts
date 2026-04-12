import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import {
  makeModel,
  makeModelsResponse,
  setupManager,
} from "./accounts-manager-test-helpers"

// ---------------------------------------------------------------------------
// Load-balanced selection outside affinity-miss preselection
// ---------------------------------------------------------------------------

test("selectAccountForRequest starts with temporaryAccount then round-robins", async () => {
  const model = makeModel({ id: "free-model" })

  const temp: AccountRuntime = {
    id: "temp",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_temp",
    models: makeModelsResponse([model]),
  }

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b], { temporaryAccount: temp })

  const seen: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
  }

  // temporaryAccount is first; round-robin rotates through all.
  expect(seen).toEqual(["temp", "a", "b"])
})

test("selectAccountForRequest skips failed accounts for free models", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    failed: true,
    failureReason: "test",
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }
  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b, c])

  const seen: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
  }

  // Account "a" is failed; round-robin rotates across "b" and "c".
  expect(seen).toEqual(["b", "b", "c"])
})

test("selectAccountForRequest round-robins premium models on cache miss", async () => {
  const premium = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([premium]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([premium]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b])

  const seen: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "gpt-5", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
    expect(selection.costUnits).toBe(1)
    expect(selection.reservation).toBeDefined()
  }

  // Round-robin distributes premium requests across accounts with quota.
  expect(seen).toEqual(["a", "b", "a"])
})

test("free and premium selection both use round-robin routing", async () => {
  const free = makeModel({ id: "free-model" })
  const premium = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([free, premium]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([free, premium]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b])

  const free1 = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])
  expect(free1.ok).toBe(true)
  if (!free1.ok) return

  const free2 = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])
  expect(free2.ok).toBe(true)
  if (!free2.ok) return

  const premiumSelection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])
  expect(premiumSelection.ok).toBe(true)
  if (!premiumSelection.ok) return

  // Round-robin: free1 → a (cursor 0), free2 → b (cursor 1), premium → a (cursor 2).
  expect(free1.account.id).toBe("a")
  expect(free2.account.id).toBe("b")
  expect(premiumSelection.account.id).toBe("a")
})

test("selectAccountForRequest routes free models sequentially when accountAffinity is disabled", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b, c])
  manager.setAccountAffinityEnabled(false)

  const seen: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    seen.push(selection.account.id)
    expect(selection.costUnits).toBe(0)
    expect(selection.reservation).toBeUndefined()
  }

  expect(seen).toEqual(["a", "a", "a"])
})

// ---------------------------------------------------------------------------
// Affinity: confirmAffinity causes sticky routing
// ---------------------------------------------------------------------------

test("affinity: confirmAffinity routes subsequent requests to the same account", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b])

  // First request: sequential → account "a". Confirm affinity.
  const first = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-1" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.account.id).toBe("a")
  first.confirmAffinity?.()

  // Second request with same key: affinity cache hit → same account.
  const second = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-1" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.account.id).toBe("a")
})

test("affinity: without confirmAffinity, subsequent requests remain cache misses", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    premiumRemaining: 12,
    premiumReserved: 1,
    lastQuotaFetch: Date.now(),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
    premiumRemaining: 5,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b])

  // First request — do NOT call confirmAffinity.
  const first = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-2" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.account.id).toBe("a")
  expect(first.confirmAffinity).toBeDefined()
  // intentionally not calling confirmAffinity

  // Second request: cache is still empty, so the miss path runs again.
  const second = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-2" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.affinityHit).toBeUndefined()
  expect(second.account.id).toBe("a")
})

test("affinity: different models with same key can route to different accounts", async () => {
  const modelA = makeModel({
    id: "model-a",
    supported_endpoints: ["/chat/completions"],
  })
  const modelB = makeModel({
    id: "model-b",
    supported_endpoints: ["/chat/completions"],
  })

  const x: AccountRuntime = {
    id: "x",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_x",
    models: makeModelsResponse([modelA]),
  }
  const y: AccountRuntime = {
    id: "y",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_y",
    models: makeModelsResponse([modelB]),
  }

  const manager = setupManager([x, y])

  const selA = await manager.selectAccountForRequest(
    [{ modelId: "model-a", endpoint: "/chat/completions" }],
    { requestId: "shared-key" },
  )
  expect(selA.ok).toBe(true)
  if (!selA.ok) return
  selA.confirmAffinity?.()

  const selB = await manager.selectAccountForRequest(
    [{ modelId: "model-b", endpoint: "/chat/completions" }],
    { requestId: "shared-key" },
  )
  expect(selB.ok).toBe(true)
  if (!selB.ok) return
  selB.confirmAffinity?.()

  // Different models → different cache keys → independent routing.
  expect(selA.account.id).toBe("x")
  expect(selB.account.id).toBe("y")
})

test("affinity: affinityModelId shares stickiness across different candidate models", async () => {
  const bigModel = makeModel({
    id: "big-model",
    supported_endpoints: ["/chat/completions"],
  })
  const smallModel = makeModel({
    id: "small-model",
    supported_endpoints: ["/chat/completions"],
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([bigModel, smallModel]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([bigModel, smallModel]),
  }

  const manager = setupManager([a, b])

  const first = await manager.selectAccountForRequest(
    [{ modelId: "small-model", endpoint: "/chat/completions" }],
    { requestId: "shared-key", affinityModelId: "big-model" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.account.id).toBe("a")
  first.confirmAffinity?.()

  const second = await manager.selectAccountForRequest(
    [{ modelId: "big-model", endpoint: "/chat/completions" }],
    { requestId: "shared-key" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return

  expect(second.account.id).toBe("a")
  expect(second.affinityHit).toBe(true)
  expect(second.affinityCacheKey).toBe("shared-key:big-model")
})

test("affinity: preferred_account_unavailable keeps the existing fallback behavior", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    premiumRemaining: 30,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
    premiumRemaining: 1,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }
  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    models: makeModelsResponse([model]),
    premiumRemaining: 2,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b, c])

  // Establish affinity to account "a".
  const first = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-3" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  first.confirmAffinity?.()
  expect(first.account.id).toBe("a")

  // Mark "a" as failed and make "c" the strongest cache-miss candidate.
  a.failed = true
  a.failureReason = "test"
  c.premiumRemaining = 25

  // Next request: affinity points to "a" but it's failed, so fallback stays on the old path.
  const second = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-3" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.account.id).toBe("b")
  expect(second.selectionReason).toBe("preferred_account_unavailable")
})

test("affinity: no affinity context uses round-robin", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b])

  // No affinity context → round-robin across accounts.
  const seen: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const selection = await manager.selectAccountForRequest([
      { modelId: "free-model", endpoint: "/chat/completions" },
    ])
    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    seen.push(selection.account.id)
    expect(selection.confirmAffinity).toBeUndefined()
  }
  expect(seen).toEqual(["a", "b", "a"])
})

test("affinity: disabled → no confirmAffinity callback even with context", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a])
  manager.setAccountAffinityEnabled(false)

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-x" },
  )
  expect(selection.ok).toBe(true)
  if (!selection.ok) return
  expect(selection.confirmAffinity).toBeUndefined()
})

test("ownership: subagent owner hit keeps same account across different models", async () => {
  const smallModel = makeModel({ id: "small-model" })
  const bigModel = makeModel({ id: "big-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([smallModel, bigModel]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([smallModel, bigModel]),
  }

  const manager = setupManager([a, b])

  const mainRequest = await manager.selectAccountForRequest(
    [{ modelId: "small-model", endpoint: "/chat/completions" }],
    { ownershipWriteSessionId: "root-session-1" },
  )
  expect(mainRequest.ok).toBe(true)
  if (!mainRequest.ok) return
  expect(mainRequest.account.id).toBe("a")
  expect(mainRequest.confirmOwnership).toBeDefined()
  mainRequest.confirmOwnership?.()

  const subagentRequest = await manager.selectAccountForRequest(
    [{ modelId: "big-model", endpoint: "/chat/completions" }],
    { ownershipLookupSessionId: "root-session-1" },
  )
  expect(subagentRequest.ok).toBe(true)
  if (!subagentRequest.ok) return

  expect(subagentRequest.account.id).toBe("a")
  expect(subagentRequest.selectionReason).toBe("subagent_owner_hit")
  expect(subagentRequest.confirmOwnership).toBeUndefined()
})

test("ownership: subagent owner miss falls back to existing path", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b])

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { ownershipLookupSessionId: "missing-root-session" },
  )
  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("a")
  expect(selection.selectionReason).toBe("subagent_owner_miss")
  expect(selection.confirmOwnership).toBeUndefined()
})

test("ownership: shutdown clears cached owner before next lifecycle", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b])

  const warmup = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])
  expect(warmup.ok).toBe(true)
  if (!warmup.ok) return
  expect(warmup.account.id).toBe("a")

  const ownedRequest = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { ownershipWriteSessionId: "root-session-1" },
  )
  expect(ownedRequest.ok).toBe(true)
  if (!ownedRequest.ok) return
  expect(ownedRequest.account.id).toBe("b")
  ownedRequest.confirmOwnership?.()

  manager.shutdown()

  const internals = manager as unknown as {
    accounts: Map<string, AccountRuntime>
    accountOrder: Array<string>
  }
  internals.accounts.set(a.id, a)
  internals.accounts.set(b.id, b)
  internals.accountOrder.push(a.id, b.id)

  const afterShutdown = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { ownershipLookupSessionId: "root-session-1" },
  )
  expect(afterShutdown.ok).toBe(true)
  if (!afterShutdown.ok) return

  expect(afterShutdown.account.id).toBe("a")
  expect(afterShutdown.selectionReason).toBe("subagent_owner_miss")
})

test("ownership: shutdown ignores delayed confirmOwnership callbacks", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b])

  const warmup = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])
  expect(warmup.ok).toBe(true)
  if (!warmup.ok) return
  expect(warmup.account.id).toBe("a")

  const ownedRequest = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { ownershipWriteSessionId: "root-session-1" },
  )
  expect(ownedRequest.ok).toBe(true)
  if (!ownedRequest.ok) return
  expect(ownedRequest.account.id).toBe("b")

  manager.shutdown()

  const internals = manager as unknown as {
    accounts: Map<string, AccountRuntime>
    accountOrder: Array<string>
  }
  internals.accounts.set(a.id, a)
  internals.accounts.set(b.id, b)
  internals.accountOrder.push(a.id, b.id)

  ownedRequest.confirmOwnership?.()

  const afterShutdown = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { ownershipLookupSessionId: "root-session-1" },
  )
  expect(afterShutdown.ok).toBe(true)
  if (!afterShutdown.ok) return

  expect(afterShutdown.account.id).toBe("a")
  expect(afterShutdown.selectionReason).toBe("subagent_owner_miss")
})

test("ownership: unusable owner keeps fallback reason when affinity cache hits", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    premiumRemaining: 1,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b])

  const mainRequest = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { ownershipWriteSessionId: "root-session-1" },
  )
  expect(mainRequest.ok).toBe(true)
  if (!mainRequest.ok) return
  expect(mainRequest.account.id).toBe("a")
  mainRequest.confirmOwnership?.()

  const affinitySeed = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-affinity" },
  )
  expect(affinitySeed.ok).toBe(true)
  if (!affinitySeed.ok) return
  expect(affinitySeed.account.id).toBe("b")
  affinitySeed.confirmAffinity?.()

  a.failed = true
  a.failureReason = "owner unavailable"

  const subagentRequest = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    {
      ownershipLookupSessionId: "root-session-1",
      requestId: "session-affinity",
    },
  )
  expect(subagentRequest.ok).toBe(true)
  if (!subagentRequest.ok) return

  expect(subagentRequest.account.id).toBe("b")
  expect(subagentRequest.affinityHit).toBe(true)
  expect(subagentRequest.selectionReason).toBe(
    "subagent_owner_unusable_fallback",
  )
})
