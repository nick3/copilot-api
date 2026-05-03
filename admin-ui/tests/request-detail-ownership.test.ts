import { expect, test } from "bun:test"

import { buildRequestDetailResponsesItemOwnerRows } from "../src/lib/request-detail-ownership"

test("buildRequestDetailResponsesItemOwnerRows exposes structured lookup and recorded keys", () => {
  const rows = buildRequestDetailResponsesItemOwnerRows({
    responses_item_owner_lookup_keys_json: JSON.stringify(["lookup-key"]),
    responses_item_owner_recorded_keys_json: JSON.stringify(["recorded-key"]),
  })

  expect(rows).toEqual([
    {
      id: "lookup",
      labelKey: "requestDetailPage.fields.responsesItemOwnerLookupKeys",
      tooltipKey: "requestDetailPage.fieldTooltip.responsesItemOwnerLookupKeys",
      value: {
        raw: "lookup-key",
        lines: ["lookup-key"],
        count: 1,
        charCount: 10,
        previewLines: ["lookup-key"],
        hiddenCount: 0,
        empty: false,
      },
    },
    {
      id: "recorded",
      labelKey: "requestDetailPage.fields.responsesItemOwnerRecordedKeys",
      tooltipKey:
        "requestDetailPage.fieldTooltip.responsesItemOwnerRecordedKeys",
      value: {
        raw: "recorded-key",
        lines: ["recorded-key"],
        count: 1,
        charCount: 12,
        previewLines: ["recorded-key"],
        hiddenCount: 0,
        empty: false,
      },
    },
  ])
})

test("buildRequestDetailResponsesItemOwnerRows uses placeholder metadata for empty keys", () => {
  const rows = buildRequestDetailResponsesItemOwnerRows({})

  expect(rows.map((row) => row.value)).toEqual([
    {
      raw: "—",
      lines: [],
      count: 0,
      charCount: 0,
      previewLines: ["—"],
      hiddenCount: 0,
      empty: true,
    },
    {
      raw: "—",
      lines: [],
      count: 0,
      charCount: 0,
      previewLines: ["—"],
      hiddenCount: 0,
      empty: true,
    },
  ])
})
