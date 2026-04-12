import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import {
  makeModel,
  makeModelsResponse,
  runWithMockedRandom,
  setupManager,
} from "./accounts-manager-test-helpers"

// ---------------------------------------------------------------------------
// Affinity-miss preselection
// ---------------------------------------------------------------------------

test("affinity miss selects the free-model account with the highest effective premium remaining", async () => {
  const model = makeModel({
    id: "free-model",
    billing: {
      is_premium: false,
      multiplier: 0,
    },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    premiumReserved: 4,
    lastQuotaFetch: Date.now(),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
    premiumRemaining: 8,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }
  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    models: makeModelsResponse([model]),
    premiumRemaining: 3,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b, c])

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-affinity-miss-highest" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("b")
  expect(selection.selectionReason).toBe("affinity_miss")
  expect(selection.costUnits).toBe(0)
  expect(selection.reservation).toBeUndefined()
})

test("affinity miss randomly breaks ties between accounts with the same effective premium remaining", async () => {
  const model = makeModel({ id: "free-model" })

  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    models: makeModelsResponse([model]),
    premiumRemaining: 7,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }
  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    premiumReserved: 2,
    lastQuotaFetch: Date.now(),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
    premiumRemaining: 9,
    premiumReserved: 1,
    lastQuotaFetch: Date.now(),
  }

  const lowRollSelection = await runWithMockedRandom(0, async () => {
    const lowRollManager = setupManager([{ ...c }, { ...a }, { ...b }])
    return lowRollManager.selectAccountForRequest(
      [{ modelId: "free-model", endpoint: "/chat/completions" }],
      { requestId: "session-affinity-miss-tie-low" },
    )
  })

  const highRollSelection = await runWithMockedRandom(0.999999, async () => {
    const highRollManager = setupManager([{ ...c }, { ...a }, { ...b }])
    return highRollManager.selectAccountForRequest(
      [{ modelId: "free-model", endpoint: "/chat/completions" }],
      { requestId: "session-affinity-miss-tie-high" },
    )
  })

  expect(lowRollSelection.ok).toBe(true)
  expect(highRollSelection.ok).toBe(true)
  if (!lowRollSelection.ok || !highRollSelection.ok) return

  expect(["a", "b"]).toContain(lowRollSelection.account.id)
  expect(["a", "b"]).toContain(highRollSelection.account.id)
  expect(lowRollSelection.account.id).not.toBe(highRollSelection.account.id)
  expect(lowRollSelection.selectionReason).toBe("affinity_miss")
  expect(highRollSelection.selectionReason).toBe("affinity_miss")
})

test("affinity miss prefers scored accounts before unlimited accounts", async () => {
  const model = makeModel({ id: "free-model" })

  const unlimited: AccountRuntime = {
    id: "unlimited",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_unlimited",
    models: makeModelsResponse([model]),
    unlimited: true,
  }
  const scored: AccountRuntime = {
    id: "scored",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_scored",
    models: makeModelsResponse([model]),
    premiumRemaining: 2,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([unlimited, scored])

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-affinity-miss-scored" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("scored")
  expect(selection.selectionReason).toBe("affinity_miss")
})

test("affinity miss keeps fallback unknown accounts ahead of unlimited when a scored account is unusable", async () => {
  const freeModel = makeModel({ id: "free-model" })
  const otherModel = makeModel({ id: "other-model" })

  const unlimited: AccountRuntime = {
    id: "unlimited",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_unlimited",
    models: makeModelsResponse([freeModel]),
    unlimited: true,
  }
  const scoredButUnsupported: AccountRuntime = {
    id: "scored-unsupported",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_scored_unsupported",
    models: makeModelsResponse([otherModel]),
    premiumRemaining: 5,
    premiumReserved: 0,
    lastQuotaFetch: Date.now(),
  }
  const fallbackUnknown: AccountRuntime = {
    id: "fallback-unknown",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_fallback_unknown",
    models: makeModelsResponse([freeModel]),
  }

  const manager = setupManager([
    unlimited,
    scoredButUnsupported,
    fallbackUnknown,
  ])

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-affinity-miss-scored-unusable" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("fallback-unknown")
  expect(selection.selectionReason).toBe("affinity_miss")
})

test("affinity miss falls back to unlimited accounts when no scored account exists", async () => {
  const model = makeModel({ id: "free-model" })

  const unknown: AccountRuntime = {
    id: "unknown",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_unknown",
    models: makeModelsResponse([model]),
  }
  const unlimited: AccountRuntime = {
    id: "unlimited",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_unlimited",
    models: makeModelsResponse([model]),
    unlimited: true,
  }

  const manager = setupManager([unknown, unlimited])

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-affinity-miss-unlimited" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("unlimited")
  expect(selection.selectionReason).toBe("affinity_miss")
})

test("affinity miss reorders unlimited fallback from original account order", async () => {
  const model = makeModel({ id: "free-model" })

  const unlimitedA: AccountRuntime = {
    id: "unlimited-a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_unlimited_a",
    models: makeModelsResponse([model]),
    unlimited: true,
  }
  const unlimitedB: AccountRuntime = {
    id: "unlimited-b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_unlimited_b",
    models: makeModelsResponse([model]),
    unlimited: true,
  }

  const manager = setupManager([unlimitedA, unlimitedB])

  const warmup = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])
  expect(warmup.ok).toBe(true)
  if (!warmup.ok) return
  expect(warmup.account.id).toBe("unlimited-a")

  const selection = await runWithMockedRandom(0, async () => {
    return manager.selectAccountForRequest(
      [{ modelId: "free-model", endpoint: "/chat/completions" }],
      { requestId: "session-affinity-miss-unlimited-rotated" },
    )
  })

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("unlimited-b")
  expect(selection.selectionReason).toBe("rotated_after_miss")
})
