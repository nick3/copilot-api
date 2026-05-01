import { expect, test } from "bun:test"

import type { ResolvedQuotaRefreshConfig } from "~/lib/config"
import type { AccountRuntime } from "~/lib/types/account"

import { AccountsManager } from "~/lib/accounts-manager"
import {
  QuotaRefreshScheduler,
  type QuotaRefreshManager,
} from "~/lib/accounts-manager-quota-scheduler"
import {
  quotaRefreshScheduler,
  registerQuotaRefreshSchedulerShutdownCleanup,
} from "~/lib/quota-refresh-scheduler-runtime"

type ScheduledTimer = {
  callback: () => void
  delayMs: number
}

type ShutdownEvent = "exit"

class FakeShutdownRuntime {
  private readonly listeners = new Map<ShutdownEvent, () => void>()

  once(event: ShutdownEvent, listener: () => void): void {
    this.listeners.set(event, listener)
  }

  emit(event: ShutdownEvent): void {
    this.listeners.get(event)?.()
  }
}

class FakeTimer {
  private nextHandle = 1
  private readonly timers = new Map<number, ScheduledTimer>()

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const handle = this.nextHandle++
    this.timers.set(handle, { callback, delayMs })
    return handle
  }

  clearTimer = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.timers.delete(handle)
    }
  }

  get delayMsList(): Array<number> {
    return [...this.timers.values()].map((timer) => timer.delayMs)
  }

  runNext(): number {
    const next = this.timers.entries().next()
    if (next.done) {
      throw new Error("No timer scheduled")
    }

    const [handle, timer] = next.value
    this.timers.delete(handle)
    timer.callback()
    return timer.delayMs
  }
}

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const config = (
  overrides: Partial<ResolvedQuotaRefreshConfig> = {},
): ResolvedQuotaRefreshConfig => ({
  enabled: true,
  intervalMinutes: 360,
  startupDelaySeconds: 60,
  staggerMinSeconds: 2,
  staggerMaxSeconds: 2,
  ...overrides,
})

const account = (id: string, overrides: Partial<AccountRuntime> = {}) => ({
  id,
  accountType: "individual" as const,
  addedAt: 1,
  githubToken: `ghp_${id}`,
  copilotToken: `copilot_${id}`,
  ...overrides,
})

const logger = {
  debug() {},
  error() {},
}

test("QuotaRefreshScheduler schedules the first round after startup delay", () => {
  const fakeTimer = new FakeTimer()
  const manager: QuotaRefreshManager = {
    getQuotaRefreshAccounts: () => [],
    refreshAccountQuota: () => Promise.resolve(),
  }
  const scheduler = new QuotaRefreshScheduler({
    config: config(),
    logger,
    manager,
    timer: fakeTimer,
  })

  scheduler.start()

  expect(fakeTimer.delayMsList).toEqual([60_000])
})

test("QuotaRefreshScheduler does not schedule when disabled", () => {
  const fakeTimer = new FakeTimer()
  const manager: QuotaRefreshManager = {
    getQuotaRefreshAccounts: () => [],
    refreshAccountQuota: () => Promise.resolve(),
  }
  const scheduler = new QuotaRefreshScheduler({
    config: config({ enabled: false }),
    logger,
    manager,
    timer: fakeTimer,
  })

  scheduler.start()

  expect(fakeTimer.delayMsList).toEqual([])
})

test("QuotaRefreshScheduler refreshes serially and isolates account failures", async () => {
  const fakeTimer = new FakeTimer()
  const calls: Array<string> = []
  const manager: QuotaRefreshManager = {
    getQuotaRefreshAccounts: () => [account("a"), account("b")],
    refreshAccountQuota: (runtime) => {
      calls.push(runtime.id)
      if (runtime.id === "a") {
        return Promise.reject(new Error("boom"))
      }
      return Promise.resolve()
    },
  }
  const scheduler = new QuotaRefreshScheduler({
    config: config({ startupDelaySeconds: 0 }),
    logger,
    manager,
    random: () => 0.5,
    timer: fakeTimer,
  })

  scheduler.start()
  fakeTimer.runNext()
  await flushAsyncWork()

  expect(calls).toEqual(["a"])
  expect(fakeTimer.delayMsList).toEqual([2_000])

  fakeTimer.runNext()
  await flushAsyncWork()

  expect(calls).toEqual(["a", "b"])
  expect(fakeTimer.delayMsList).toEqual([21_600_000])
})

test("QuotaRefreshScheduler stop clears a pending stagger delay", async () => {
  const fakeTimer = new FakeTimer()
  const calls: Array<string> = []
  const manager: QuotaRefreshManager = {
    getQuotaRefreshAccounts: () => [account("a"), account("b")],
    refreshAccountQuota: (runtime) => {
      calls.push(runtime.id)
      return Promise.resolve()
    },
  }
  const scheduler = new QuotaRefreshScheduler({
    config: config({ startupDelaySeconds: 0 }),
    logger,
    manager,
    timer: fakeTimer,
  })

  scheduler.start()
  fakeTimer.runNext()
  await flushAsyncWork()

  scheduler.stop()
  await flushAsyncWork()

  expect(calls).toEqual(["a"])
  expect(fakeTimer.delayMsList).toEqual([])
})

test("QuotaRefreshScheduler updateConfig disables work during a pending stagger delay", async () => {
  const fakeTimer = new FakeTimer()
  const calls: Array<string> = []
  const manager: QuotaRefreshManager = {
    getQuotaRefreshAccounts: () => [account("a"), account("b")],
    refreshAccountQuota: (runtime) => {
      calls.push(runtime.id)
      return Promise.resolve()
    },
  }
  const scheduler = new QuotaRefreshScheduler({
    config: config({ startupDelaySeconds: 0 }),
    logger,
    manager,
    timer: fakeTimer,
  })

  scheduler.start()
  fakeTimer.runNext()
  await flushAsyncWork()

  scheduler.updateConfig(config({ enabled: false }))
  await flushAsyncWork()

  expect(calls).toEqual(["a"])
  expect(fakeTimer.delayMsList).toEqual([])
})

test("QuotaRefreshScheduler does not schedule when interval is non-positive", () => {
  const fakeTimer = new FakeTimer()
  const manager: QuotaRefreshManager = {
    getQuotaRefreshAccounts: () => [],
    refreshAccountQuota: () => Promise.resolve(),
  }
  const scheduler = new QuotaRefreshScheduler({
    config: config({ intervalMinutes: 0 }),
    logger,
    manager,
    timer: fakeTimer,
  })

  scheduler.start()

  expect(fakeTimer.delayMsList).toEqual([])
})

test("QuotaRefreshScheduler schedules the next round when account snapshot fails", async () => {
  const fakeTimer = new FakeTimer()
  const errors: Array<Array<unknown>> = []
  const manager: QuotaRefreshManager = {
    getQuotaRefreshAccounts: () => {
      throw new Error("snapshot failed")
    },
    refreshAccountQuota: () => Promise.resolve(),
  }
  const scheduler = new QuotaRefreshScheduler({
    config: config({ startupDelaySeconds: 0 }),
    logger: {
      debug() {},
      error(...args) {
        errors.push(args)
      },
    },
    manager,
    random: () => 0.5,
    timer: fakeTimer,
  })

  scheduler.start()
  fakeTimer.runNext()
  await flushAsyncWork()

  expect(errors).toHaveLength(1)
  expect(fakeTimer.delayMsList).toEqual([21_600_000])
})

test("QuotaRefreshScheduler skips accounts refreshed inside the freshness guard", async () => {
  const fakeTimer = new FakeTimer()
  const calls: Array<string> = []
  const manager: QuotaRefreshManager = {
    getQuotaRefreshAccounts: () => [
      account("fresh", { lastQuotaFetch: 9_900 }),
      account("stale"),
    ],
    refreshAccountQuota: (runtime) => {
      calls.push(runtime.id)
      return Promise.resolve()
    },
  }
  const scheduler = new QuotaRefreshScheduler({
    config: config({ startupDelaySeconds: 0 }),
    logger,
    manager,
    now: () => 10_000,
    random: () => 0.5,
    timer: fakeTimer,
  })

  scheduler.start()
  fakeTimer.runNext()
  await flushAsyncWork()

  expect(calls).toEqual(["stale"])
  expect(fakeTimer.delayMsList).toEqual([21_600_000])
})

test("quota refresh scheduler runtime stops scheduler on process exit", () => {
  const fakeRuntime = new FakeShutdownRuntime()
  const originalStop = quotaRefreshScheduler.stop.bind(quotaRefreshScheduler)
  let stops = 0

  quotaRefreshScheduler.stop = () => {
    stops += 1
  }

  try {
    registerQuotaRefreshSchedulerShutdownCleanup(fakeRuntime)
    fakeRuntime.emit("exit")

    expect(stops).toBe(1)
  } finally {
    quotaRefreshScheduler.stop = originalStop
  }
})

test("AccountsManager returns a quota refresh account snapshot", () => {
  const manager = new AccountsManager()
  const refreshable = account("refreshable")
  const disabled = account("disabled", { enabled: false })
  const failed = account("failed", { failed: true })
  const uninitialized = account("uninitialized", { copilotToken: undefined })
  const temporary = account("temporary")
  const internals = manager as unknown as {
    accountOrder: Array<string>
    accounts: Map<string, AccountRuntime>
    temporaryAccount?: AccountRuntime
  }

  for (const runtime of [refreshable, disabled, failed, uninitialized]) {
    internals.accounts.set(runtime.id, runtime)
    internals.accountOrder.push(runtime.id)
  }
  internals.temporaryAccount = temporary

  const accounts = manager.getQuotaRefreshAccounts()

  expect(accounts.map((runtime) => runtime.id)).toEqual([
    "temporary",
    "refreshable",
  ])
  expect(accounts).not.toBe(manager.getQuotaRefreshAccounts())
})
