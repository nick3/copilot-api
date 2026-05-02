import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { initAdminDb } from "~/lib/admin-db"
import { RequestHistoryStore } from "~/lib/request-history"

test("RequestHistoryStore persists Responses item ownership keys", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  const store = new RequestHistoryStore(db)

  const lookupKeys = ["responses-item-owner:id:lookup"]
  const recordedKeys = ["responses-item-owner:id:recorded"]

  store.insert({
    requestId: "req-owner-keys",
    startedAtMs: 1,
    method: "POST",
    path: "/v1/messages",
    stream: false,
    responsesItemOwnerLookupKeysJson: JSON.stringify(lookupKeys),
    responsesItemOwnerRecordedKeysJson: JSON.stringify(recordedKeys),
  })

  const row = store.getByRequestId("req-owner-keys")

  expect(row?.responses_item_owner_lookup_keys_json).toBe(
    JSON.stringify(lookupKeys),
  )
  expect(row?.responses_item_owner_recorded_keys_json).toBe(
    JSON.stringify(recordedKeys),
  )
})
