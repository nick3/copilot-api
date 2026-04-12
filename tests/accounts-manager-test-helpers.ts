import type { AccountRuntime } from "../src/lib/types/account"
import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

import { AccountsManager } from "../src/lib/accounts-manager"

export const makeModel = (overrides: Partial<Model> = {}): Model => {
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

export const makeModelsResponse = (models: Array<Model>): ModelsResponse => ({
  object: "list",
  data: models,
})

export const setupManager = (
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
