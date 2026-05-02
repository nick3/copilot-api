import type { AdminRequestItem } from "./admin-api"

const EMPTY = "—"

type ResponsesItemOwnerFields = Pick<
  AdminRequestItem,
  | "responses_item_owner_lookup_keys_json"
  | "responses_item_owner_recorded_keys_json"
>

export type RequestDetailResponsesItemOwnerRow = {
  labelKey: string
  tooltipKey: string
  value: string
}

export function buildRequestDetailResponsesItemOwnerRows(
  item: Partial<ResponsesItemOwnerFields>,
): Array<RequestDetailResponsesItemOwnerRow> {
  return [
    {
      labelKey: "requestDetailPage.fields.responsesItemOwnerLookupKeys",
      tooltipKey: "requestDetailPage.fieldTooltip.responsesItemOwnerLookupKeys",
      value: formatOwnerKeys(item.responses_item_owner_lookup_keys_json),
    },
    {
      labelKey: "requestDetailPage.fields.responsesItemOwnerRecordedKeys",
      tooltipKey: "requestDetailPage.fieldTooltip.responsesItemOwnerRecordedKeys",
      value: formatOwnerKeys(item.responses_item_owner_recorded_keys_json),
    },
  ]
}

function formatOwnerKeys(raw: string | null | undefined): string {
  if (!raw) {
    return EMPTY
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return raw
    }

    const values = parsed.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    return values.length > 0 ? values.join("\n") : EMPTY
  } catch {
    return raw
  }
}
