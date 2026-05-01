import { accountsManager } from "~/lib/accounts-manager"
import { QuotaRefreshScheduler } from "~/lib/accounts-manager-quota-scheduler"
import { getQuotaRefreshConfig } from "~/lib/config"

export const quotaRefreshScheduler = new QuotaRefreshScheduler({
  config: getQuotaRefreshConfig(),
  manager: accountsManager,
})

type ShutdownRuntime = {
  once(event: "exit", listener: () => void): unknown
}

const registeredShutdownRuntimes = new WeakSet<ShutdownRuntime>()
let isQuotaRefreshSchedulerStarted = false

export function startQuotaRefreshSchedulerFromConfig(): void {
  isQuotaRefreshSchedulerStarted = true
  quotaRefreshScheduler.start(getQuotaRefreshConfig())
}

export function stopQuotaRefreshScheduler(): void {
  isQuotaRefreshSchedulerStarted = false
  quotaRefreshScheduler.stop()
}

export function registerQuotaRefreshSchedulerShutdownCleanup(
  runtime: ShutdownRuntime = process,
): void {
  if (registeredShutdownRuntimes.has(runtime)) {
    return
  }

  registeredShutdownRuntimes.add(runtime)
  runtime.once("exit", () => stopQuotaRefreshScheduler())
}

export function updateQuotaRefreshSchedulerFromConfig(): void {
  if (!isQuotaRefreshSchedulerStarted) {
    return
  }

  quotaRefreshScheduler.updateConfig(getQuotaRefreshConfig())
}
