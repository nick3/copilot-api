import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"
import type { Model, ModelsResponse } from "../src/services/copilot/get-models"
import type { QuotaDetail } from "../src/services/github/get-copilot-usage"

import { AccountsManager } from "../src/lib/accounts-manager"
import { getCostUnits } from "../src/lib/accounts-manager-quota"
import {
  applyQuotaRefreshSuccessIfCurrent,
  takeAuthSnapshot,
} from "../src/lib/accounts-manager-auth"

const makeModel = (overrides: Partial<Model> = {}): Model => {
  const base: Model = {
    billing: {
      is_premium: true,
      multiplier: 1,
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

type ManagerInternals = {
  accounts: Map<string, AccountRuntime>
  accountOrder: Array<string>
}

const setupManagerWithAccounts = (
  ...accounts: Array<AccountRuntime>
): AccountsManager => {
  const manager = new AccountsManager()
  const internals = manager as unknown as ManagerInternals

  for (const account of accounts) {
    internals.accounts.set(account.id, account)
    internals.accountOrder.push(account.id)
  }

  return manager
}

const setupManagerWithAccount = (account: AccountRuntime): AccountsManager =>
  setupManagerWithAccounts(account)

const disableQuotaRefresh = (manager: AccountsManager): void => {
  ;(manager as unknown as { refreshQuota: () => Promise<void> }).refreshQuota =
    async () => {}
}

test("selectAccountForRequest reserves multiplier units and releases on finalizeQuota", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 2.5,
    },
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.costUnits).toBe(2.5)
  expect(selection.reservation).toBeDefined()
  expect(account.premiumReserved).toBe(2.5)

  // Avoid network calls from finalizeQuota() in unit test.
  disableQuotaRefresh(manager)

  await manager.finalizeQuota(account, selection.reservation)

  expect(account.premiumReserved).toBe(0)
  expect(account.premiumReservations).toBeUndefined()
})

test("selectAccountForRequest prevents oversubscription with in-flight reservation", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 1,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const first = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])
  expect(first.ok).toBe(true)

  const second = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])
  expect(second.ok).toBe(false)
  if (second.ok) return

  expect(second.reason).toBe("NO_QUOTA")
})

test("selectAccountForRequest returns MODEL_NOT_SUPPORTED when endpoint is not supported", async () => {
  const model = makeModel({
    id: "gpt-5",
    supported_endpoints: ["/chat/completions"],
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/responses" },
  ])

  expect(selection.ok).toBe(false)
  if (selection.ok) return

  expect(selection.reason).toBe("MODEL_NOT_SUPPORTED")
})

test("selectAccountForRequest keeps the requested model for token-based billing accounts", async () => {
  const requestedModel = makeModel({
    id: "requested-model",
    billing: undefined,
  })
  const smallModel = makeModel({ id: "small-model", billing: undefined })
  const account: AccountRuntime = {
    id: "token-billed",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([requestedModel, smallModel]),
    tokenBasedBilling: true,
  }
  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    {
      modelId: "small-model",
      tokenBasedBillingModelId: "requested-model",
      endpoint: "/chat/completions",
    },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return
  expect(selection.selectedModel.id).toBe("requested-model")
})

test("selectAccountForRequest uses the small model when token billing is explicitly disabled", async () => {
  const requestedModel = makeModel({
    id: "requested-model",
    billing: {
      is_premium: true,
      multiplier: 1,
      token_prices: { input_price: 1 },
    },
  })
  const smallModel = makeModel({ id: "small-model", billing: undefined })
  const account: AccountRuntime = {
    id: "premium-request-billed",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([requestedModel, smallModel]),
    tokenBasedBilling: false,
  }
  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    {
      modelId: "small-model",
      tokenBasedBillingModelId: "requested-model",
      endpoint: "/chat/completions",
    },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return
  expect(selection.selectedModel.id).toBe("small-model")
})

test("selectAccountForRequest infers token billing from model prices when account metadata is missing", async () => {
  const requestedModel = makeModel({
    id: "requested-model",
    billing: {
      is_premium: true,
      multiplier: 1,
      token_prices: { input_price: 1 },
    },
  })
  const smallModel = makeModel({ id: "small-model", billing: undefined })
  const account: AccountRuntime = {
    id: "legacy-token-billed",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([requestedModel, smallModel]),
    unlimited: true,
  }
  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    {
      modelId: "small-model",
      tokenBasedBillingModelId: "requested-model",
      endpoint: "/chat/completions",
    },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return
  expect(selection.selectedModel.id).toBe("requested-model")
})

test("account affinity keeps warmup routing on the token-billed account", async () => {
  const requestedModel = makeModel({
    id: "requested-model",
    billing: undefined,
  })
  const smallModel = makeModel({ id: "small-model", billing: undefined })
  const premiumRequestAccount: AccountRuntime = {
    id: "premium-request-account",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_premium_request",
    models: makeModelsResponse([smallModel]),
    tokenBasedBilling: false,
  }
  const tokenBilledAccount: AccountRuntime = {
    id: "token-billed-account",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_token_billed",
    models: makeModelsResponse([requestedModel]),
    tokenBasedBilling: true,
  }
  const manager = setupManagerWithAccounts(
    premiumRequestAccount,
    tokenBilledAccount,
  )
  manager.setAccountAffinityEnabled(true)

  const initial = await manager.selectAccountForRequest(
    [{ modelId: "requested-model", endpoint: "/chat/completions" }],
    { requestId: "shared-session" },
  )
  expect(initial.ok).toBe(true)
  if (!initial.ok) return
  expect(initial.account.id).toBe("token-billed-account")
  initial.confirmAffinity?.()

  const warmup = await manager.selectAccountForRequest(
    [
      {
        modelId: "small-model",
        tokenBasedBillingModelId: "requested-model",
        endpoint: "/chat/completions",
      },
    ],
    { requestId: "shared-session", affinityModelId: "requested-model" },
  )

  expect(warmup.ok).toBe(true)
  if (!warmup.ok) return
  expect(warmup.account.id).toBe("token-billed-account")
  expect(warmup.selectedModel.id).toBe("requested-model")
  expect(warmup.affinityHit).toBe(true)
})

test("selectAccountForRequest skips a disabled model and uses another account", async () => {
  const disabledModel = makeModel({
    billing: undefined,
    id: "shared-model",
    policy: { state: "disabled", terms: "" },
  })
  const enabledModel = makeModel({
    billing: undefined,
    id: "shared-model",
  })

  const disabledAccount: AccountRuntime = {
    id: "disabled-account",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_disabled",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([disabledModel]),
  }
  const enabledAccount: AccountRuntime = {
    id: "enabled-account",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_enabled",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([enabledModel]),
  }

  const manager = setupManagerWithAccounts(disabledAccount, enabledAccount)
  const selection = await manager.selectAccountForRequest([
    { modelId: "shared-model", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("enabled-account")
})

test("selectAccountForRequest treats missing billing as free (costUnits=0)", async () => {
  const model = makeModel({
    id: "free-model",
    billing: undefined,
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "free-model", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.costUnits).toBe(0)
  expect(selection.reservation).toBeUndefined()
  expect(account.premiumReserved).toBeUndefined()
})

test("selectAccountForRequest treats token-priced models as billable", async () => {
  const model = makeModel({
    id: "gpt-5-token-priced",
    billing: {
      token_prices: {
        batch_size: 1_000_000,
        cache_price: 50_000_000_000,
        input_price: 500_000_000_000,
        output_price: 3_000_000_000_000,
      },
    },
  })

  const account: AccountRuntime = {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5-token-priced", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.costUnits).toBe(1)
  expect(selection.reservation).toBeDefined()
  expect(account.premiumReserved).toBe(1)
})

test("getCostUnits treats tiered token-priced models as billable", () => {
  const model = makeModel({
    id: "gpt-5-tiered-token-priced",
    billing: {
      token_prices: {
        batch_size: 1_000_000,
        default: {
          cache_price: 50,
          input_price: 500,
          output_price: 3_000,
        },
      },
    },
  })

  expect(getCostUnits(model)).toBe(1)
})

test("selectAccountForRequest allows request with overagePermitted=true when quota exhausted", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const account: AccountRuntime = {
    id: "enterprise-user",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    overagePermitted: true,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.costUnits).toBe(1)
  expect(selection.reservation).toBeDefined()
  expect(account.premiumReserved).toBe(1)
})

test("selectAccountForRequest rejects request with overagePermitted=false when quota exhausted", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const account: AccountRuntime = {
    id: "individual-user",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    overagePermitted: false,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(false)
  if (selection.ok) return

  expect(selection.reason).toBe("NO_QUOTA")
})

test("selectAccountForRequest creates reservation for overagePermitted account even when quota exhausted", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 2,
    },
  })

  const account: AccountRuntime = {
    id: "enterprise-user",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    overagePermitted: true,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const first = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])
  expect(first.ok).toBe(true)
  if (!first.ok) return

  expect(first.reservation).toBeDefined()
  expect(account.premiumReserved).toBe(2)

  const second = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])
  expect(second.ok).toBe(true)
  if (!second.ok) return

  expect(second.reservation).toBeDefined()
  expect(account.premiumReserved).toBe(4)
})

test("selectAccountForRequest does not create reservation for unlimited account", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const account: AccountRuntime = {
    id: "unlimited-user",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    unlimited: true,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.reservation).toBeUndefined()
  expect(account.premiumReserved).toBeUndefined()
})

test("selectAccountForRequest prefers account with quota over overage account", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  // First account has overage permission but no quota
  const overageAccount: AccountRuntime = {
    id: "overage-enterprise",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_overage",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    overagePermitted: true,
    lastQuotaFetch: Date.now(),
  }

  // Second account has quota available
  const quotaAccount: AccountRuntime = {
    id: "has-quota",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_quota",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    overagePermitted: false,
    lastQuotaFetch: Date.now(),
  }

  // Overage account is first in order, but quota account should be preferred
  const manager = setupManagerWithAccounts(overageAccount, quotaAccount)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  // Should select quota account, not overage account
  expect(selection.account.id).toBe("has-quota")
})

test("selectAccountForRequest falls back to overage account when all quota exhausted", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  // First account has overage permission but no quota
  const overageAccount: AccountRuntime = {
    id: "overage-enterprise",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_overage",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    overagePermitted: true,
    lastQuotaFetch: Date.now(),
  }

  // Second account also has no quota and no overage
  const exhaustedAccount: AccountRuntime = {
    id: "exhausted",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_exhausted",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    overagePermitted: false,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccounts(overageAccount, exhaustedAccount)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  // Should fall back to overage account since no quota available
  expect(selection.account.id).toBe("overage-enterprise")
})

test("selectAccountForRequest falls back to next account when first has no overage and no quota", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const exhaustedAccount: AccountRuntime = {
    id: "exhausted",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_exhausted",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    overagePermitted: false,
    lastQuotaFetch: Date.now(),
  }

  const availableAccount: AccountRuntime = {
    id: "available",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_available",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    overagePermitted: false,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccounts(exhaustedAccount, availableAccount)

  const selection = await manager.selectAccountForRequest([
    { modelId: "gpt-5", endpoint: "/chat/completions" },
  ])

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("available")
})

test("ownership: unusable owner falls back safely for premium requests", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const preferredAccount: AccountRuntime = {
    id: "preferred",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_preferred",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 1,
    lastQuotaFetch: Date.now(),
  }
  const fallbackAccount: AccountRuntime = {
    id: "fallback",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_fallback",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 10,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccounts(preferredAccount, fallbackAccount)

  const mainRequest = await manager.selectAccountForRequest(
    [{ modelId: "gpt-5", endpoint: "/chat/completions" }],
    { ownershipWriteSessionId: "root-session-premium" },
  )
  expect(mainRequest.ok).toBe(true)
  if (!mainRequest.ok) return

  expect(mainRequest.account.id).toBe("preferred")
  expect(mainRequest.confirmOwnership).toBeDefined()
  mainRequest.confirmOwnership?.()
  disableQuotaRefresh(manager)

  await manager.finalizeQuota(preferredAccount, mainRequest.reservation)
  preferredAccount.premiumRemaining = 0

  const subagentRequest = await manager.selectAccountForRequest(
    [{ modelId: "gpt-5", endpoint: "/chat/completions" }],
    { ownershipLookupSessionId: "root-session-premium" },
  )
  expect(subagentRequest.ok).toBe(true)
  if (!subagentRequest.ok) return

  expect(subagentRequest.account.id).toBe("fallback")
  expect(subagentRequest.selectionReason).toBe(
    "subagent_owner_unusable_fallback",
  )
  expect(subagentRequest.confirmOwnership).toBeUndefined()
})

test("ownership: unusable owner keeps fallback reason when final selection fails", async () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
    },
  })

  const preferredAccount: AccountRuntime = {
    id: "preferred",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_preferred",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 1,
    lastQuotaFetch: Date.now(),
  }
  const fallbackAccount: AccountRuntime = {
    id: "fallback",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_fallback",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 0,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccounts(preferredAccount, fallbackAccount)

  const mainRequest = await manager.selectAccountForRequest(
    [{ modelId: "gpt-5", endpoint: "/chat/completions" }],
    { ownershipWriteSessionId: "root-session-premium" },
  )
  expect(mainRequest.ok).toBe(true)
  if (!mainRequest.ok) return

  mainRequest.confirmOwnership?.()
  disableQuotaRefresh(manager)

  await manager.finalizeQuota(preferredAccount, mainRequest.reservation)
  preferredAccount.premiumRemaining = 0

  const subagentRequest = await manager.selectAccountForRequest(
    [{ modelId: "gpt-5", endpoint: "/chat/completions" }],
    { ownershipLookupSessionId: "root-session-premium" },
  )
  expect(subagentRequest.ok).toBe(false)
  if (subagentRequest.ok) return

  expect(subagentRequest.reason).toBe("NO_QUOTA")
  expect(subagentRequest.selectionReason).toBe(
    "subagent_owner_unusable_fallback",
  )
})

test("applyQuotaRefreshSuccessIfCurrent sets overagePermitted from quota response", () => {
  const account: AccountRuntime = {
    id: "test-user",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
  }

  const snapshot = takeAuthSnapshot(account)

  const premium: QuotaDetail = {
    entitlement: 100,
    overage_count: 5,
    overage_permitted: true,
    percent_remaining: 50,
    quota_id: "quota-123",
    quota_remaining: 50,
    remaining: 50,
    unlimited: false,
  }

  const applied = applyQuotaRefreshSuccessIfCurrent(account, snapshot, {
    premium,
    tokenBasedBilling: true,
  })

  expect(applied).toBe(true)
  expect(account.overagePermitted).toBe(true)
  expect(account.unlimited).toBe(false)
  expect(account.premiumRemaining).toBe(50)
  expect(account.tokenBasedBilling).toBe(true)

  const reapplied = applyQuotaRefreshSuccessIfCurrent(account, snapshot, {
    premium,
  })
  expect(reapplied).toBe(true)
  expect(account.tokenBasedBilling).toBeUndefined()
})

test("getAccountStatus includes runtime billing metadata in returned status", () => {
  const model = makeModel({
    id: "gpt-5",
    billing: {
      is_premium: true,
      multiplier: 1,
      token_prices: { input_price: 500_000_000_000 },
    },
  })

  const account: AccountRuntime = {
    id: "enterprise-user",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
    premiumRemaining: 50,
    premiumEntitlement: 100,
    overagePermitted: true,
    unlimited: false,
    lastQuotaFetch: Date.now(),
  }

  const manager = setupManagerWithAccount(account)
  const statuses = manager.getAccountStatus()

  expect(statuses).toHaveLength(1)
  expect(statuses[0].id).toBe("enterprise-user")
  expect(statuses[0].overagePermitted).toBe(true)
  expect(statuses[0].tokenBasedBilling).toBe(true)
  expect(statuses[0].unlimited).toBe(false)
})

test("getAccountStatus detects zero-valued tiered token pricing", () => {
  const model = makeModel({
    id: "gpt-5-tiered-zero-price",
    billing: {
      token_prices: {
        batch_size: 0,
        default: {
          cache_price: 0,
          input_price: 0,
          output_price: 0,
        },
      },
    },
  })

  const account: AccountRuntime = {
    id: "enterprise-tiered-user",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
  }

  const manager = setupManagerWithAccount(account)
  const statuses = manager.getAccountStatus()

  expect(statuses[0].tokenBasedBilling).toBe(true)
})

test("getAccountStatus prefers explicit token billing metadata over model-price inference", () => {
  const model = makeModel({
    id: "gpt-5-token-priced",
    billing: {
      token_prices: { input_price: 1 },
    },
  })
  const account: AccountRuntime = {
    id: "explicit-premium-request-account",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    models: makeModelsResponse([model]),
    tokenBasedBilling: false,
  }

  const manager = setupManagerWithAccount(account)
  const statuses = manager.getAccountStatus()

  expect(statuses[0].tokenBasedBilling).toBe(false)
})

test("getCostUnits ignores empty token prices", () => {
  expect(
    getCostUnits(
      makeModel({
        billing: {
          is_premium: false,
          token_prices: {},
        },
      }),
    ),
  ).toBe(0)

  expect(
    getCostUnits(
      makeModel({
        billing: {
          is_premium: true,
          token_prices: {},
        },
      }),
    ),
  ).toBe(0)
})

test("getAccountStatus ignores empty token prices for runtime billing metadata", () => {
  const model = makeModel({
    id: "gpt-5-empty-prices",
    billing: {
      is_premium: true,
      token_prices: {},
    },
  })

  const account: AccountRuntime = {
    id: "enterprise-user",
    accountType: "enterprise",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    vsCodeVersion: "1.0.0",
    models: makeModelsResponse([model]),
  }

  const manager = setupManagerWithAccount(account)
  const statuses = manager.getAccountStatus()

  expect(statuses[0].tokenBasedBilling).toBe(false)
})
