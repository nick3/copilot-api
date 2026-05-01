import consola from "consola"

import type { ResolvedQuotaRefreshConfig } from "~/lib/config"
import type { AccountRuntime } from "~/lib/types/account"

export const QUOTA_REFRESH_FRESHNESS_GUARD_MS = 5 * 60 * 1000
export const QUOTA_REFRESH_INTERVAL_JITTER_RATIO = 0.1

export interface QuotaRefreshManager {
  getQuotaRefreshAccounts(): Array<AccountRuntime>
  refreshAccountQuota(account: AccountRuntime): Promise<void>
}

type Logger = {
  debug(...args: Array<unknown>): void
  error(...args: Array<unknown>): void
}

type TimerHandle = unknown

type SchedulerTimer = {
  clearTimer(handle: TimerHandle): void
  setTimer(callback: () => void, delayMs: number): TimerHandle
}

export interface QuotaRefreshSchedulerOptions {
  config: ResolvedQuotaRefreshConfig
  manager: QuotaRefreshManager
  logger?: Logger
  now?: () => number
  random?: () => number
  timer?: SchedulerTimer
}

type PendingDelay = {
  handle: TimerHandle
  resolve: () => void
}

const defaultTimer: SchedulerTimer = {
  setTimer(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  clearTimer(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

function secondsToMs(seconds: number): number {
  return seconds * 1000
}

function minutesToMs(minutes: number): number {
  return minutes * 60 * 1000
}

function isSchedulingEnabled(config: ResolvedQuotaRefreshConfig): boolean {
  return config.enabled && config.intervalMinutes > 0
}

export class QuotaRefreshScheduler {
  private config: ResolvedQuotaRefreshConfig
  private readonly logger: Logger
  private readonly manager: QuotaRefreshManager
  private readonly now: () => number
  private readonly random: () => number
  private readonly timer: SchedulerTimer
  private pendingDelay?: PendingDelay
  private roundTimer?: TimerHandle
  private stopped = true

  constructor(options: QuotaRefreshSchedulerOptions) {
    this.config = options.config
    this.logger = options.logger ?? consola
    this.manager = options.manager
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.timer = options.timer ?? defaultTimer
  }

  start(config = this.config): void {
    this.config = config
    this.stop()

    if (!isSchedulingEnabled(this.config)) {
      return
    }

    this.stopped = false
    this.scheduleRound(secondsToMs(this.config.startupDelaySeconds))
  }

  stop(): void {
    this.stopped = true
    this.clearRoundTimer()
    this.clearPendingDelay()
  }

  updateConfig(config: ResolvedQuotaRefreshConfig): void {
    this.start(config)
  }

  private scheduleRound(delayMs: number): void {
    this.clearRoundTimer()
    this.roundTimer = this.timer.setTimer(
      () => {
        this.roundTimer = undefined
        void this.runRound()
      },
      Math.max(0, delayMs),
    )
  }

  private scheduleNextRound(): void {
    if (!isSchedulingEnabled(this.config)) {
      return
    }

    const intervalMs = minutesToMs(this.config.intervalMinutes)
    this.scheduleRound(this.withJitter(intervalMs))
  }

  private withJitter(intervalMs: number): number {
    const jitterMs = Math.floor(
      intervalMs
        * QUOTA_REFRESH_INTERVAL_JITTER_RATIO
        * (this.random() * 2 - 1),
    )
    return Math.max(0, intervalMs + jitterMs)
  }

  private getStaggerDelayMs(): number {
    const minMs = secondsToMs(this.config.staggerMinSeconds)
    const maxMs = secondsToMs(this.config.staggerMaxSeconds)
    if (maxMs <= minMs) {
      return minMs
    }

    return minMs + Math.floor(this.random() * (maxMs - minMs))
  }

  private isFresh(account: AccountRuntime): boolean {
    if (account.lastQuotaFetch === undefined) {
      return false
    }

    return (
      this.now() - account.lastQuotaFetch < QUOTA_REFRESH_FRESHNESS_GUARD_MS
    )
  }

  private async schedulerDelay(delayMs: number): Promise<void> {
    this.clearPendingDelay()

    await new Promise<void>((resolve) => {
      const handle = this.timer.setTimer(
        () => {
          if (this.pendingDelay?.handle === handle) {
            this.pendingDelay = undefined
          }
          resolve()
        },
        Math.max(0, delayMs),
      )

      this.pendingDelay = { handle, resolve }
    })
  }

  private clearRoundTimer(): void {
    if (this.roundTimer === undefined) {
      return
    }

    this.timer.clearTimer(this.roundTimer)
    this.roundTimer = undefined
  }

  private clearPendingDelay(): void {
    if (!this.pendingDelay) {
      return
    }

    const { handle, resolve } = this.pendingDelay
    this.pendingDelay = undefined
    this.timer.clearTimer(handle)
    resolve()
  }

  private async runRound(): Promise<void> {
    try {
      const accounts = this.manager.getQuotaRefreshAccounts()

      for (const [index, account] of accounts.entries()) {
        if (this.stopped) {
          return
        }
        if (this.isFresh(account)) {
          continue
        }

        try {
          await this.manager.refreshAccountQuota(account)
        } catch (error) {
          this.logger.debug("Background quota refresh failed", {
            accountId: account.id,
            error,
          })
        }

        if (index < accounts.length - 1) {
          await this.schedulerDelay(this.getStaggerDelayMs())
        }
      }
    } catch (error) {
      this.logger.error("Background quota refresh round failed", error)
    } finally {
      if (!this.stopped) {
        this.scheduleNextRound()
      }
    }
  }
}
