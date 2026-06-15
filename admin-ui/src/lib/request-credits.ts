import type { AdminRequestItem } from "@/lib/admin-api"
import { fmtNum } from "@/lib/format"

export function formatRequestCreditsRemaining(
  item: Pick<AdminRequestItem, "credits_unlimited_after" | "credits_remaining_after">,
): string {
  if (item.credits_unlimited_after) {
    return "∞"
  }

  if (item.credits_remaining_after != null) {
    return fmtNum(item.credits_remaining_after)
  }

  return ""
}
