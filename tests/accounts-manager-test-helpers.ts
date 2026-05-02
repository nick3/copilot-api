import type { AffinityPersistenceStoreProvider } from "../src/lib/account-affinity"
import type { AccountRuntime } from "../src/lib/types/account"
import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

import { AccountsManager } from "../src/lib/accounts-manager"

type SetupManagerOptions = {
  temporaryAccount?: AccountRuntime
  persistentAffinityStore?: AffinityPersistenceStoreProvider
}

export function makeModel(overrides: Partial<Model> = {}): Model {
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

export function makeModelsResponse(models: Array<Model>): ModelsResponse {
  return {
    object: "list",
    data: models,
  }
}

export function setupManager(
  accounts: Array<AccountRuntime>,
  options?: SetupManagerOptions,
): AccountsManager {
  const { temporaryAccount, persistentAffinityStore } = options ?? {}
  const manager = new AccountsManager({ persistentAffinityStore })
  const internals = manager as unknown as {
    accounts: Map<string, AccountRuntime>
    accountOrder: Array<string>
    temporaryAccount?: AccountRuntime
  }

  for (const account of accounts) {
    internals.accounts.set(account.id, account)
    internals.accountOrder.push(account.id)
  }

  if (temporaryAccount) {
    internals.temporaryAccount = temporaryAccount
  }

  return manager
}

export async function runWithMockedRandom<T>(
  value: number,
  run: () => Promise<T>,
): Promise<T> {
  const math = Math as { random: () => number }
  const originalRandom = math.random

  try {
    math.random = () => value
    return await run()
  } finally {
    math.random = originalRandom
  }
}
