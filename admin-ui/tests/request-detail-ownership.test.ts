import { expect, test } from "bun:test"

import { buildRequestDetailResponsesItemOwnerRows } from "../src/lib/request-detail-ownership"

test("buildRequestDetailResponsesItemOwnerRows exposes lookup and recorded keys", () => {
  const rows = buildRequestDetailResponsesItemOwnerRows({
    responses_item_owner_lookup_keys_json: JSON.stringify(["lookup-key"]),
    responses_item_owner_recorded_keys_json: JSON.stringify(["recorded-key"]),
  })

  expect(rows).toEqual([
    {
      labelKey: "requestDetailPage.fields.responsesItemOwnerLookupKeys",
      tooltipKey: "requestDetailPage.fieldTooltip.responsesItemOwnerLookupKeys",
      value: "lookup-key",
    },
    {
      labelKey: "requestDetailPage.fields.responsesItemOwnerRecordedKeys",
      tooltipKey:
        "requestDetailPage.fieldTooltip.responsesItemOwnerRecordedKeys",
      value: "recorded-key",
    },
  ])
})

test("buildRequestDetailResponsesItemOwnerRows uses placeholder for empty keys", () => {
  const rows = buildRequestDetailResponsesItemOwnerRows({})

  expect(rows.map((row) => row.value)).toEqual(["—", "—"])
})
