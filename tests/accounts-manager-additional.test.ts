import { expect, mock, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"
import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

import { AccountsManager } from "../src/lib/accounts-manager"

const makeModel = (overrides: Partial<Model> = {}): Model => {
  const base: Model = {
    billing: {
      is_premium: false,
      multiplier: 0,
    },
    capabilities: {
      family: "test",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "test",
      type: "test",
    },
    id: "test-model",
    model_picker_enabled: true,
    name: "Test model",
    object: "model",
    preview: false,
    supported_endpoints: ["/chat/completions"],
    vendor: "test",
    version: "0",
  }

  return {
    ...base,
    ...overrides,
  }
}

const makeModelsResponse = (models: Array<Model>): ModelsResponse => ({
  object: "list",
  data: models,
})

const setupManager = (
  accounts: Array<AccountRuntime>,
  options?: { temporaryAccount?: AccountRuntime },
): AccountsManager => {
  const manager = new AccountsManager()
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

test("selectAccountForRequest returns NO_ACCOUNTS when no accounts exist", async () => {
  const manager = new AccountsManager()

  const result = await manager.selectAccountForRequest([
    { modelId: "any-model", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(false)
  if (result.ok) return

  expect(result.reason).toBe("NO_ACCOUNTS")
})

test("selectAccountForRequest returns NO_QUOTA when all accounts exhausted", async () => {
  const model = makeModel({
    id: "premium",
    billing: { is_premium: true, multiplier: 1 },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a])

  const result = await manager.selectAccountForRequest([
    { modelId: "premium", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(false)
  if (result.ok) return

  expect(result.reason).toBe("NO_QUOTA")
})

test("selectAccountForRequest handles unlimited quota", async () => {
  const model = makeModel({
    id: "premium",
    billing: { is_premium: true, multiplier: 1 },
  })

  const account: AccountRuntime = {
    id: "unlimited",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    unlimited: true,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([account])

  const result = await manager.selectAccountForRequest([
    { modelId: "premium", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(true)
  if (!result.ok) return

  expect(result.account.id).toBe("unlimited")
  expect(result.costUnits).toBe(1)
  expect(result.reservation).toBeUndefined()
})

test("selectAccountForRequest handles invalid multiplier as 1", async () => {
  const model = makeModel({
    id: "invalid-multiplier",
    billing: { is_premium: true, multiplier: -5 },
  })

  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([account])

  const result = await manager.selectAccountForRequest([
    { modelId: "invalid-multiplier", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(true)
  if (!result.ok) return

  expect(result.costUnits).toBe(1)
})

test("selectAccountForRequest tries multiple candidates in order", async () => {
  const model1 = makeModel({ id: "model1" })
  const model2 = makeModel({ id: "model2" })

  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([model2]),
  }

  const manager = setupManager([account])

  const result = await manager.selectAccountForRequest([
    { modelId: "model1", endpoint: "/chat/completions" },
    { modelId: "model2", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(true)
  if (!result.ok) return

  expect(result.selectedModel.id).toBe("model2")
})

test("selectAccountForRequest respects endpoint support", async () => {
  const modelOnlyChat = makeModel({
    id: "chat-only",
    supported_endpoints: ["/chat/completions"],
  })

  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([modelOnlyChat]),
  }

  const manager = setupManager([account])

  const result = await manager.selectAccountForRequest([
    { modelId: "chat-only", endpoint: "/responses" },
  ])

  expect(result.ok).toBe(false)
  if (result.ok) return

  expect(result.reason).toBe("MODEL_NOT_SUPPORTED")
})

test("selectAccountForRequest allows models with no supported_endpoints for non-responses", async () => {
  const modelNoEndpoints = makeModel({
    id: "legacy",
    supported_endpoints: undefined,
  })

  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([modelNoEndpoints]),
  }

  const manager = setupManager([account])

  const result = await manager.selectAccountForRequest([
    { modelId: "legacy", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(true)
  if (!result.ok) return

  expect(result.selectedModel.id).toBe("legacy")
})

test("getAccountStatus returns runtime state for all accounts", () => {
  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    premiumRemaining: 10,
    unlimited: false,
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "business",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    premiumRemaining: undefined,
    unlimited: true,
  }

  const temp: AccountRuntime = {
    id: "temp",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_temp",
    failed: true,
    failureReason: "test failure",
  }

  const manager = setupManager([a, b], { temporaryAccount: temp })

  const statuses = manager.getAccountStatus()

  expect(statuses.length).toBe(3)
  expect(statuses[0].id).toBe("(temporary)")
  expect(statuses[0].failed).toBe(true)
  expect(statuses[1].id).toBe("a")
  expect(statuses[1].remaining).toBe(10)
  expect(statuses[2].id).toBe("b")
  expect(statuses[2].unlimited).toBe(true)
})

test("hasAccounts returns true when accounts exist", () => {
  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
  }

  const manager = setupManager([account])

  expect(manager.hasAccounts()).toBe(true)
})

test("hasAccounts returns false when no accounts", () => {
  const manager = new AccountsManager()

  expect(manager.hasAccounts()).toBe(false)
})

test("getAccountContextByIndex returns null for invalid index", () => {
  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
  }

  const manager = setupManager([account])

  expect(manager.getAccountContextByIndex(-1)).toBeNull()
  expect(manager.getAccountContextByIndex(1)).toBeNull()
})

test("getAccountContextByIndex returns context for valid index", () => {
  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    copilotToken: "copilot_test",
    vsCodeVersion: "1.0.0",
  }

  const manager = setupManager([account])

  const ctx = manager.getAccountContextByIndex(0)

  expect(ctx).not.toBeNull()
  expect(ctx?.githubToken).toBe("ghp_test")
  expect(ctx?.copilotToken).toBe("copilot_test")
  expect(ctx?.accountType).toBe("individual")
})

test("getAccountContextByIndex prioritizes temporary account at index 0", () => {
  const temp: AccountRuntime = {
    id: "temp",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_temp",
  }

  const regular: AccountRuntime = {
    id: "regular",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_regular",
  }

  const manager = setupManager([regular], { temporaryAccount: temp })

  const ctx0 = manager.getAccountContextByIndex(0)
  const ctx1 = manager.getAccountContextByIndex(1)

  expect(ctx0?.githubToken).toBe("ghp_temp")
  expect(ctx1?.githubToken).toBe("ghp_regular")
})

test("getAccountCount includes temporary account", () => {
  const temp: AccountRuntime = {
    id: "temp",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_temp",
  }

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
  }

  const manager = setupManager([a, b], { temporaryAccount: temp })

  expect(manager.getAccountCount()).toBe(3)
})

test("markAccountFailed marks registered account as failed", () => {
  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
  }

  const manager = setupManager([account])

  manager.markAccountFailed("test", "test reason")

  expect(account.failed).toBe(true)
  expect(account.failureReason).toBe("test reason")
})

test("markAccountFailed marks temporary account as failed", () => {
  const temp: AccountRuntime = {
    id: "temp",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_temp",
  }

  const manager = setupManager([], { temporaryAccount: temp })

  manager.markAccountFailed("temp", "test reason")

  expect(temp.failed).toBe(true)
  expect(temp.failureReason).toBe("test reason")
})

test("getFirstAccountModels returns temporary account models first", () => {
  const tempModels = makeModelsResponse([makeModel({ id: "temp-model" })])
  const regularModels = makeModelsResponse([makeModel({ id: "regular-model" })])

  const temp: AccountRuntime = {
    id: "temp",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_temp",
    models: tempModels,
  }

  const regular: AccountRuntime = {
    id: "regular",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_regular",
    models: regularModels,
  }

  const manager = setupManager([regular], { temporaryAccount: temp })

  const models = manager.getFirstAccountModels()

  expect(models?.data[0].id).toBe("temp-model")
})

test("getFirstAccountModels returns undefined when no models available", () => {
  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
  }

  const manager = setupManager([account])

  expect(manager.getFirstAccountModels()).toBeUndefined()
})

test("finalizeQuota releases reservation without refreshing on error", async () => {
  const model = makeModel({
    id: "premium",
    billing: { is_premium: true, multiplier: 1 },
  })

  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([account])

  const result = await manager.selectAccountForRequest([
    { modelId: "premium", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(true)
  if (!result.ok) return

  const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
  const originalFetch = fetchHolder.fetch

  const fetchMock = mock(() => new Response("error", { status: 500 }))
  fetchHolder.fetch = fetchMock as unknown as typeof fetch

  try {
    await manager.finalizeQuota(account, result.reservation)
  } finally {
    fetchHolder.fetch = originalFetch
  }

  expect(account.premiumReserved).toBe(0)
})

test("selectAccountForRequest with multiple premium multipliers", async () => {
  const model1 = makeModel({
    id: "gpt-4",
    billing: { is_premium: true, multiplier: 1 },
  })
  const model2 = makeModel({
    id: "gpt-5-premium",
    billing: { is_premium: true, multiplier: 3.5 },
  })

  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([model1, model2]),
    premiumRemaining: 5,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([account])

  const result1 = await manager.selectAccountForRequest([
    { modelId: "gpt-5-premium", endpoint: "/chat/completions" },
  ])

  expect(result1.ok).toBe(true)
  if (!result1.ok) return
  expect(result1.costUnits).toBe(3.5)
  expect(account.premiumReserved).toBe(3.5)

  const result2 = await manager.selectAccountForRequest([
    { modelId: "gpt-4", endpoint: "/chat/completions" },
  ])

  expect(result2.ok).toBe(true)
  if (!result2.ok) return
  expect(result2.costUnits).toBe(1)
  expect(account.premiumReserved).toBe(4.5)
})

test("selectAccountForRequest falls back to next account when quota insufficient", async () => {
  const model = makeModel({
    id: "premium",
    billing: { is_premium: true, multiplier: 2 },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
    premiumRemaining: 1,
    lastQuotaFetch: Date.now(),
  }

  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([a, b])

  const result = await manager.selectAccountForRequest([
    { modelId: "premium", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(true)
  if (!result.ok) return

  expect(result.account.id).toBe("b")
  expect(result.costUnits).toBe(2)
})

test("selectAccountForRequest with is_premium=false and non-zero multiplier is treated as free", async () => {
  const model = makeModel({
    id: "free-with-multiplier",
    billing: { is_premium: false, multiplier: 2 },
  })

  const account: AccountRuntime = {
    id: "test",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManager([account])

  const result = await manager.selectAccountForRequest([
    { modelId: "free-with-multiplier", endpoint: "/chat/completions" },
  ])

  expect(result.ok).toBe(true)
  if (!result.ok) return

  expect(result.costUnits).toBe(0)
  expect(result.reservation).toBeUndefined()
})