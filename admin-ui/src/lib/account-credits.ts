import type { AdminAccountItem } from "@/lib/admin-api"

export type AccountCreditsSummary = {
  isUnlimited: boolean
  entitlement?: number
  remaining?: number
  used?: number
  percentUsed?: number
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function getAccountCreditsSummary(
  account: AdminAccountItem,
): AccountCreditsSummary {
  const runtime = account.runtime
  const entitlement = runtime?.creditsEntitlement
  const remaining = runtime?.creditsRemaining
  const used =
    entitlement != null && remaining != null ? entitlement - remaining : undefined
  const percentUsedRaw =
    entitlement != null && entitlement > 0 && used != null
      ? (used / entitlement) * 100
      : undefined

  return {
    isUnlimited: runtime?.creditsUnlimited === true,
    entitlement,
    remaining,
    used,
    percentUsed:
      percentUsedRaw != null && Number.isFinite(percentUsedRaw)
        ? clampPercent(percentUsedRaw)
        : undefined,
  }
}
