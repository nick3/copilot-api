import type { AdminModelDetailsItem } from "@/lib/admin-api"

export function isBillableModel(
  model: Pick<AdminModelDetailsItem, "billing">,
): boolean {
  return model.billing?.tokenBasedBilling === true || model.billing?.is_premium === true
}
