/* eslint-disable @typescript-eslint/unbound-method -- Bun spies are asserted without invoking the detached methods. */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  getConfig,
  invalidateConfigCache,
  reloadConfig,
  writeConfigToDisk,
  type AppConfig,
} from "~/lib/config"
import { reloadServerConfig } from "~/lib/config-reload"
import { accountsManager } from "~/lib/accounts-manager"
import * as credentials from "~/lib/credential-store"
import { PATHS } from "~/lib/paths"
import { state, type State } from "~/lib/state"
import * as tokens from "~/lib/token"
import type { CodexCredentials } from "~/lib/oauth/codex"

const originalConfigPath = PATHS.CONFIG_PATH
let tempDir: string
let originalState: State
function saveConfig(overrides: AppConfig = {}): void {
  writeConfigToDisk({
    auth: { apiKeys: ["old-api"] },
    providers: { "github-copilot": { enabled: false } },
    ...overrides,
  })
}
function createCodexCredentials(accountId: string): CodexCredentials {
  return {
    accountId,
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: 0,
  }
}
beforeEach(() => {
  originalState = { ...state }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiaccount-reload-"))
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  saveConfig()
  reloadConfig()
  spyOn(accountsManager, "setCopilotEnabled").mockResolvedValue(undefined)
  spyOn(accountsManager, "reloadRegistryNow").mockResolvedValue(undefined)
})
afterEach(() => {
  mock.restore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, originalState)
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  fs.rmSync(tempDir, { recursive: true, force: true })
})
describe("running multi-account config reload", () => {
  test("loads current API keys and applies the Copilot switch through AccountsManager", async () => {
    saveConfig({
      auth: { apiKeys: ["new-api"] },
      providers: {
        "github-copilot": { enabled: false },
        custom: { apiKey: "new-key" },
      },
    })
    await reloadServerConfig()
    expect(getConfig().auth?.apiKeys).toEqual(["new-api"])
    expect(getConfig().providers?.custom.apiKey).toBe("new-key")
    expect(accountsManager.setCopilotEnabled).toHaveBeenCalledWith(false)
    expect(accountsManager.reloadRegistryNow).toHaveBeenCalledTimes(1)
  })
  test("keeps the previous cached configuration when the file is invalid", async () => {
    fs.writeFileSync(PATHS.CONFIG_PATH, "{")
    const failure: unknown = await reloadServerConfig().catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(getConfig().auth?.apiKeys).toEqual(["old-api"])
    expect(accountsManager.setCopilotEnabled).not.toHaveBeenCalled()
  })
  test("retries after an apply failure and invalidates stale Codex credentials", async () => {
    spyOn(accountsManager, "setCopilotEnabled")
      .mockRejectedValueOnce(new Error("temporary initialization failure"))
      .mockResolvedValue(undefined)
    expect(reloadServerConfig()).rejects.toThrow(
      "temporary initialization failure",
    )
    state.codexAccessToken = "stale"
    state.codexAccountId = "previous"
    await reloadServerConfig()
    expect(state.codexAccessToken).toBeUndefined()
    expect(state.codexAccountId).toBeUndefined()
  })
  test("keeps Codex refresh attempts separate when accounts switch", async () => {
    const accountA = createCodexCredentials("account-a")
    const accountB = createCodexCredentials("account-b")
    const refreshingA = Promise.withResolvers<CodexCredentials>()
    const dependencies: tokens.CodexRefreshDependencies = {
      getCurrentCredentials: () => null,
      persistCodexCredentials: mock(() => Promise.resolve()),
      refreshCodexCredentials: mock((snapshot: CodexCredentials) =>
        snapshot.accountId === accountA.accountId ?
          refreshingA.promise
        : Promise.resolve({ ...snapshot, accessToken: "refreshed-b" }),
      ),
    }
    const first = tokens.refreshCodexCredentialsOnce(accountA, dependencies)
    expect(tokens.refreshCodexCredentialsOnce(accountA, dependencies)).toBe(
      first,
    )
    const second = await tokens.refreshCodexCredentialsOnce(
      accountB,
      dependencies,
    )
    refreshingA.resolve({ ...accountA, accessToken: "refreshed-a" })
    expect((await first).accountId).toBe("account-a")
    expect(second.accountId).toBe("account-b")
    expect(second.accessToken).toBe("refreshed-b")
    expect(dependencies.refreshCodexCredentials).toHaveBeenCalledTimes(2)
  })

  test("does not reuse another Codex account's rotated credentials", async () => {
    const accountB = createCodexCredentials("account-b")
    const dependencies: tokens.CodexRefreshDependencies = {
      getCurrentCredentials: () => ({
        ...createCodexCredentials("account-a"),
        expiresAt: Date.now() + 60_000,
      }),
      persistCodexCredentials: () => Promise.resolve(),
      refreshCodexCredentials: mock((snapshot: CodexCredentials) =>
        Promise.resolve({ ...snapshot, accessToken: "refreshed-b" }),
      ),
    }
    const result = await tokens.refreshCodexCredentialsOnce(
      accountB,
      dependencies,
    )
    expect(result.accountId).toBe("account-b")
    expect(dependencies.refreshCodexCredentials).toHaveBeenCalledWith(accountB)
  })

  test("keeps a failed Codex persistence retry isolated from other accounts", async () => {
    const accountA = createCodexCredentials("account-a")
    const accountB = createCodexCredentials("account-b")
    const dependenciesA: tokens.CodexRefreshDependencies = {
      getCurrentCredentials: () => null,
      persistCodexCredentials: mock(() =>
        Promise.resolve(),
      ).mockRejectedValueOnce(new Error("disk unavailable")),
      refreshCodexCredentials: mock(() =>
        Promise.resolve({ ...accountA, accessToken: "refreshed-a" }),
      ),
    }
    const failure = await tokens
      .refreshCodexCredentialsOnce(accountA, dependenciesA)
      .catch((error: unknown) => error)
    expect(failure).toHaveProperty("message", "disk unavailable")
    const resultB = await tokens.refreshCodexCredentialsOnce(accountB, {
      getCurrentCredentials: () => null,
      persistCodexCredentials: () => Promise.resolve(),
      refreshCodexCredentials: (snapshot) => Promise.resolve(snapshot),
    })
    expect(resultB.accountId).toBe("account-b")
    const retriedA = await tokens.refreshCodexCredentialsOnce(
      accountA,
      dependenciesA,
    )
    expect(retriedA.accessToken).toBe("refreshed-a")
    expect(dependenciesA.refreshCodexCredentials).toHaveBeenCalledTimes(1)
  })

  test("discards failed refresh persistence for a new sign-in without losing another account's retry", async () => {
    const accountA = createCodexCredentials("pending-signin-a")
    const accountB = createCodexCredentials("pending-signin-b")
    const createDependencies = (snapshot: CodexCredentials) => ({
      getCurrentCredentials: () => null,
      persistCodexCredentials: mock(() =>
        Promise.resolve(),
      ).mockRejectedValueOnce(new Error("disk unavailable")),
      refreshCodexCredentials: mock(() =>
        Promise.resolve({ ...snapshot, accessToken: "rotated-access" }),
      ),
    })
    const dependenciesA = createDependencies(accountA)
    const dependenciesB = createDependencies(accountB)
    for (const [snapshot, dependencies] of [
      [accountA, dependenciesA],
      [accountB, dependenciesB],
    ] as const) {
      const failure = await tokens
        .refreshCodexCredentialsOnce(snapshot, dependencies)
        .catch((error: unknown) => error)
      expect(failure).toHaveProperty("message", "disk unavailable")
    }
    spyOn(credentials, "writeCodexCredentials").mockResolvedValue(undefined)
    await tokens.persistCodexCredentials({
      ...accountA,
      accessToken: "new-signin-access",
    })
    await tokens.refreshCodexCredentialsOnce(accountA, dependenciesA)
    await tokens.refreshCodexCredentialsOnce(accountB, dependenciesB)
    expect(dependenciesA.refreshCodexCredentials).toHaveBeenCalledTimes(2)
    expect(dependenciesB.refreshCodexCredentials).toHaveBeenCalledTimes(1)
  })

  test("does not replace the active account when an old Codex refresh persists", async () => {
    saveConfig({
      providers: {
        "github-copilot": { enabled: false },
        codex: { accountId: "account-b" },
      },
    })
    reloadConfig()
    state.codexAccountId = "account-b"
    state.codexAccessToken = "active-b"
    spyOn(credentials, "writeCodexCredentials").mockResolvedValue(undefined)
    await tokens.persistCodexCredentials(createCodexCredentials("account-a"), {
      syncProvider: false,
      insertIfMissing: false,
    })
    expect(state.codexAccountId).toBe("account-b")
    expect(state.codexAccessToken).toBe("active-b")
    await tokens.persistCodexCredentials(createCodexCredentials("account-b"), {
      syncProvider: false,
      insertIfMissing: false,
    })
    expect(state.codexAccountId).toBe("account-b")
    expect(state.codexAccessToken).toBe("access-account-b")
  })
})
