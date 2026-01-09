import consola from "consola"

import { state } from "./state"
import { sleep as defaultSleep } from "./utils"

export type CopilotRateLimiterSnapshot = {
  enabled: boolean
  /** Effective interval (configured vs learned). Undefined when disabled. */
  effectiveSeconds?: number
  /** Number of callers currently waiting for a permit. */
  queueDepth: number
  /** Earliest unix ms timestamp when the next permit can be granted. */
  nextAllowedAtMs: number
}

type Deps = {
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class CopilotRateLimiter {
  readonly accountId: string

  private queueDepth = 0
  private nextAllowedAtMs = 0
  private learnedIntervalSeconds = 0
  private cooldownUntilMs = 0

  private mutex: Promise<void> = Promise.resolve()

  private readonly nowMs: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(accountId: string, deps: Deps = {}) {
    this.accountId = accountId
    this.nowMs = deps.nowMs ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
  }

  snapshot(): CopilotRateLimiterSnapshot {
    const configuredSeconds = state.rateLimitSeconds
    if (configuredSeconds === undefined) {
      return {
        enabled: false,
        queueDepth: 0,
        nextAllowedAtMs: 0,
      }
    }

    const effectiveSeconds = Math.max(
      configuredSeconds,
      this.learnedIntervalSeconds,
    )
    const nextAllowedAtMs = Math.max(this.nextAllowedAtMs, this.cooldownUntilMs)

    return {
      enabled: true,
      effectiveSeconds,
      queueDepth: this.queueDepth,
      nextAllowedAtMs,
    }
  }

  /**
   * Wait for a permit to start a Copilot upstream request.
   *
   * NOTE: This limits request *start rate* only; it does not serialize the full
   * upstream request lifecycle (important for streaming endpoints).
   */
  async acquire(): Promise<void> {
    const configuredSeconds = state.rateLimitSeconds
    if (configuredSeconds === undefined) return

    this.queueDepth += 1

    if (this.queueDepth > 100) {
      consola.warn(
        `[rate-limit] High queue depth for account ${this.accountId}: ${this.queueDepth}`,
      )
    }

    let release!: () => void

    const previous = this.mutex
    this.mutex = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await previous

      while (true) {
        const now = this.nowMs()
        const effectiveSeconds = Math.max(
          configuredSeconds,
          this.learnedIntervalSeconds,
        )

        const gateMs = Math.max(this.nextAllowedAtMs, this.cooldownUntilMs)

        if (now >= gateMs) {
          // Reserve the next slot based on *actual* permit time.
          this.nextAllowedAtMs = now + effectiveSeconds * 1000
          return
        }

        await this.sleep(gateMs - now)
        // Loop to re-check in case cooldown/interval changed while sleeping.
      }
    } finally {
      release()
      this.queueDepth -= 1
    }
  }

  /**
   * Record an upstream 429 and adjust this account's limiter.
   */
  noteRateLimitHit(
    baseRetryAfterSeconds: number,
    jitteredWaitMs: number,
  ): void {
    if (state.rateLimitSeconds === undefined) return

    this.learnedIntervalSeconds = Math.max(
      this.learnedIntervalSeconds,
      baseRetryAfterSeconds,
    )

    const now = this.nowMs()
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, now + jitteredWaitMs)
  }

  /** @internal For tests */
  resetForTest(): void {
    this.queueDepth = 0
    this.nextAllowedAtMs = 0
    this.learnedIntervalSeconds = 0
    this.cooldownUntilMs = 0
    this.mutex = Promise.resolve()
  }
}

const limiters = new Map<string, CopilotRateLimiter>()

export function getCopilotRateLimiter(accountId: string): CopilotRateLimiter {
  const existing = limiters.get(accountId)
  if (existing) return existing

  const limiter = new CopilotRateLimiter(accountId)
  limiters.set(accountId, limiter)
  return limiter
}

/** @internal For tests */
export function resetCopilotRateLimitersForTest(): void {
  limiters.clear()
}
