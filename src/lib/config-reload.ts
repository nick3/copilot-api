import { accountsManager } from "./accounts-manager"
import {
  getModelRefreshIntervalMs,
  isAccountAffinityEnabled,
  reloadConfig,
} from "./config"
import { isGitHubCopilotEnabled } from "./github-copilot-provider"
import { updateQuotaRefreshSchedulerFromConfig } from "./quota-refresh-scheduler-runtime"
import { applySharedSessionAffinityRetention } from "./session-affinity-store"
import { invalidateCodexRuntime } from "./token"

let pendingReload: Promise<void> = Promise.resolve()

async function applyConfigReload(): Promise<void> {
  const config = reloadConfig()
  // A re-login can rotate credentials without changing the selected account ID.
  invalidateCodexRuntime()
  accountsManager.setAccountAffinityEnabled(isAccountAffinityEnabled())
  accountsManager.setModelsRefreshIntervalMs(getModelRefreshIntervalMs())
  await accountsManager.setCopilotEnabled(isGitHubCopilotEnabled(config))
  await accountsManager.reloadRegistryNow()
  updateQuotaRefreshSchedulerFromConfig()
  applySharedSessionAffinityRetention()
}

export function reloadServerConfig(): Promise<void> {
  const reload = pendingReload.then(applyConfigReload)
  pendingReload = reload.catch(() => {})
  return reload
}
