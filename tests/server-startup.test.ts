import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"
import nodeFs from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { DeviceCodeResponse } from "../src/services/github/get-device-code"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-startup-test-"))
const environment = {
  COPILOT_API_HOME: home,
  COPILOT_API_LOG_DIR: path.join(home, "logs"),
  COPILOT_API_SQLITE_DB_PATH: ":memory:",
  COPILOT_API_OAUTH_APP: "",
  COPILOT_API_ENTERPRISE_URL: "",
  COPILOT_API_GITHUB_TOKEN: "",
  COPILOT_API_KEY: "fixture-gateway-key",
  ADMIN_TOKEN: "fixture-admin-key",
}
const previousEnvironment = Object.fromEntries(
  Object.keys(environment).map((key) => [key, process.env[key]]),
)
Object.assign(process.env, environment)

type RegistryListener = (
  event: "change" | "rename",
  filename: string | null,
) => void
let registryListener: RegistryListener | undefined
// Exercise real registry IO and reloads, but inject OS notifications so the
// test does not depend on FSEvents/inotify availability or platform latency.
spyOn(nodeFs, "watch").mockImplementation(
  (filename: nodeFs.PathLike, options?: unknown, listener?: unknown) => {
    nodeFs.statSync(filename)
    const callback = typeof options === "function" ? options : listener
    if (filename === home) registryListener = callback as RegistryListener
    return Object.assign(new EventEmitter(), {
      close() {
        if (registryListener === callback) registryListener = undefined
      },
      ref() {
        return this
      },
      unref() {
        return this
      },
    }) as nodeFs.FSWatcher
  },
)

await mock.module("../src/services/get-vscode-version", () => ({
  getVSCodeVersion: () => Promise.resolve("1.130.0"),
}))
await mock.module("../src/lib/deviceid", () => ({
  getVSCodeDeviceId: () => Promise.resolve("fixture-device"),
}))
const getDeviceCode = mock(() => new Promise<DeviceCodeResponse>(() => {}))
await mock.module("../src/services/github/get-device-code", () => ({
  getDeviceCode,
}))
await mock.module("../src/services/github/poll-access-token", () => ({
  pollAccessToken: () => Promise.resolve("fixture-only-token"),
}))
await mock.module("../src/services/github/get-user", () => ({
  getGitHubUser: () => Promise.resolve({ login: "fixture-account" }),
}))
await mock.module("../src/services/github/get-copilot-token", () => ({
  getCopilotToken: () => Promise.reject(new Error("fixture upstream offline")),
}))

const { runServer } = await import("../src/start")
const { accountsManager } = await import("../src/lib/accounts-manager")
const { addAccountToRegistry, saveAccountToken } =
  await import("../src/lib/accounts-registry")
const { stopVsCodeSessionRefreshLoop } = await import("../src/lib/utils")
const { stopQuotaRefreshScheduler } =
  await import("../src/lib/quota-refresh-scheduler-runtime")
const { default: consola } = await import("consola")

const listeners: Array<ReturnType<typeof Bun.serve>> = []
const realServe = Bun.serve
spyOn(Bun, "serve").mockImplementation((options) => {
  const listener = realServe(options)
  listeners.push(listener)
  return listener
})
const warn = spyOn(consola, "warn")
const error = spyOn(consola, "error")
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")

const options: Parameters<typeof runServer>[0] = {
  port: 0,
  host: "127.0.0.1",
  verbose: false,
  accountType: "enterprise",
  manual: false,
  rateLimitWait: false,
  claudeCode: false,
  showToken: false,
  proxyEnv: false,
  skipAuth: false,
  enableMcpHttp: false,
}

function setInteractive(interactive: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: interactive,
    configurable: true,
  })
  Object.defineProperty(process.stdout, "isTTY", {
    value: interactive,
    configurable: true,
  })
}

async function startServer(
  overrides: Partial<typeof options> = {},
): Promise<URL> {
  await Promise.race([runServer({ ...options, ...overrides }), Bun.sleep(1000)])
  expect(listeners).toHaveLength(1)
  return listeners[0].url
}

async function expectAdminAvailable(url: URL): Promise<void> {
  const page = await fetch(new URL("/admin/", url))
  expect(page.status).toBe(200)
  expect(await page.text()).toContain("<html")
  const accounts = await fetch(new URL("/api/admin/accounts", url), {
    headers: { "x-admin-token": environment.ADMIN_TOKEN },
  })
  expect(accounts.status).toBe(200)
  expect(accountsManager.hasAccounts()).toBe(false)
  expect(
    warn.mock.calls.some(([message]) =>
      String(message).includes("Failed to start registry watcher"),
    ),
  ).toBe(false)
}

beforeEach(() => {
  getDeviceCode.mockClear()
  warn.mockClear()
  error.mockClear()
  setInteractive(false)
})

afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.stop(true)
  accountsManager.shutdown()
  stopVsCodeSessionRefreshLoop()
  stopQuotaRefreshScheduler()
  await fs.rm(path.join(home, "accounts-registry.json"), { force: true })
  await fs.rm(path.join(home, "tokens"), { recursive: true, force: true })
})

afterAll(async () => {
  mock.restore()
  if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty)
  else Reflect.deleteProperty(process.stdin, "isTTY")
  if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty)
  else Reflect.deleteProperty(process.stdout, "isTTY")
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(home, { recursive: true, force: true })
})

test("headless startup serves Admin with zero accounts and does not start device login", async () => {
  await expectAdminAvailable(await startServer())
  expect(getDeviceCode).not.toHaveBeenCalled()
})

test("interactive device login cannot block Admin or the HTTP listener", async () => {
  setInteractive(true)
  await expectAdminAvailable(await startServer())
  expect(getDeviceCode).toHaveBeenCalledTimes(1)
})

test("skip-auth still suppresses interactive login and allows first-account setup", async () => {
  setInteractive(true)
  await expectAdminAvailable(await startServer({ skipAuth: true }))
  expect(getDeviceCode).not.toHaveBeenCalled()
})

test("failed interactive login leaves Admin available", async () => {
  setInteractive(true)
  getDeviceCode.mockRejectedValueOnce(new Error("fixture login unavailable"))
  const url = await startServer()
  await expectAdminAvailable(url)
  expect(
    error.mock.calls.some(([message]) =>
      String(message).includes("Admin UI is still available"),
    ),
  ).toBe(true)
})

test("Claude Code setup without models does not prevent Admin onboarding", async () => {
  await expectAdminAvailable(await startServer({ claudeCode: true }))
  expect(getDeviceCode).not.toHaveBeenCalled()
})

async function waitForAccounts(count: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (accountsManager.getAccountCount() !== count && Date.now() < deadline) {
    await Bun.sleep(20)
  }
  expect(accountsManager.getAccountCount()).toBe(count)
}

test("interactive login loads the account without restarting the manager or listener", async () => {
  setInteractive(true)
  getDeviceCode.mockResolvedValueOnce({
    user_code: "TEST-CODE",
    device_code: "fixture-device-code",
    verification_uri: "https://example.invalid/login",
    expires_in: 900,
    interval: 5,
  })
  const shutdown = spyOn(accountsManager, "shutdown")
  const url = await startServer()
  await waitForAccounts(1)
  expect(shutdown).not.toHaveBeenCalled()
  shutdown.mockRestore()
  expect((await fetch(new URL("/admin/", url))).status).toBe(200)
  expect(
    await fs.readFile(path.join(home, "tokens/github_fixture-account"), "utf8"),
  ).toBe("fixture-only-token")
})

test("the empty-install watcher picks up first account creation and atomic registry replacement", async () => {
  const url = await startServer()
  await saveAccountToken("fixture-account", "fixture-only-token")
  await addAccountToRegistry({
    id: "fixture-account",
    accountType: "enterprise",
    addedAt: 1,
  })
  expect(registryListener).toBeFunction()
  registryListener?.("rename", "accounts-registry.json")
  await waitForAccounts(1)
  const replacement = path.join(home, "registry-next.json")
  await fs.writeFile(
    replacement,
    JSON.stringify({ version: 2, accounts: [], clientIdentities: {} }),
  )
  await fs.rename(replacement, path.join(home, "accounts-registry.json"))
  registryListener?.("rename", "accounts-registry.json")
  await waitForAccounts(0)
  await expectAdminAvailable(url)
})
