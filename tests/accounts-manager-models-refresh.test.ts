import { expect, mock, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import { AccountsManager } from "../src/lib/accounts-manager"

type ManagerInternals = {
  accounts: Map<string, AccountRuntime>
  accountOrder: Array<string>
}

const makeAccount = (
  overrides: Partial<AccountRuntime> = {},
): AccountRuntime => ({
  id: "octocat",
  accountType: "individual",
  addedAt: Date.now(),
  githubToken: "ghp_test",
  copilotToken: "tok",
  vsCodeVersion: "1.0.0",
  ...overrides,
})

const setupManager = (account: AccountRuntime): AccountsManager => {
  const manager = new AccountsManager()
  const internals = manager as unknown as ManagerInternals
  internals.accounts.set(account.id, account)
  internals.accountOrder.push(account.id)
  return manager
}

test("timer tick calls refreshAllModels and sets lastModelsFetch", async () => {
  await mock.module("../src/services/copilot/get-models", () => ({
    getModels: mock(() => Promise.resolve({ object: "list", data: [] })),
  }))

  const account = makeAccount()
  const manager = setupManager(account)

  manager.setModelsRefreshIntervalMs(50)
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  manager.setModelsRefreshIntervalMs(0)

  expect(account.lastModelsFetch).toBeGreaterThan(0)
})

test("refresh failure preserves existing models cache", async () => {
  await mock.module("../src/services/copilot/get-models", () => ({
    getModels: mock(() => Promise.reject(new Error("network error"))),
  }))

  const fakeModel = {
    id: "test-model",
    object: "model",
    billing: { is_premium: false, multiplier: 1 },
    capabilities: {
      family: "test",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "test",
      type: "test",
    },
    model_picker_enabled: false,
    name: "Test",
    preview: false,
    supported_endpoints: [] as Array<string>,
    vendor: "test",
    version: "0",
  }
  const account = makeAccount({
    models: { object: "list", data: [fakeModel] },
    lastModelsFetch: 100,
  })
  const manager = setupManager(account)

  await (
    manager as unknown as {
      refreshModels: (a: AccountRuntime) => Promise<void>
    }
  ).refreshModels(account)

  expect(account.models?.data).toEqual([fakeModel])
  expect(account.lastModelsFetch).toBe(100)
})

test("setModelsRefreshIntervalMs(0) stops scheduling", async () => {
  const getModelsMock = mock(() =>
    Promise.resolve({ object: "list", data: [] }),
  )
  await mock.module("../src/services/copilot/get-models", () => ({
    getModels: getModelsMock,
  }))

  const account = makeAccount()
  const manager = setupManager(account)

  manager.setModelsRefreshIntervalMs(50)
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  manager.setModelsRefreshIntervalMs(0)
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  expect(getModelsMock).toHaveBeenCalledTimes(0)
})

test("interval <= 0 never schedules", async () => {
  const getModelsMock = mock(() =>
    Promise.resolve({ object: "list", data: [] }),
  )
  await mock.module("../src/services/copilot/get-models", () => ({
    getModels: getModelsMock,
  }))

  const account = makeAccount()
  const manager = setupManager(account)

  manager.setModelsRefreshIntervalMs(0)
  await new Promise<void>((resolve) => setTimeout(resolve, 100))

  expect(getModelsMock).toHaveBeenCalledTimes(0)
})
