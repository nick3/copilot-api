import { expect, test } from "bun:test"

import type { AdminAccountItem } from "../src/lib/admin-api"
import {
  buildAccountsCsv,
  getAccountsCsvFilename,
} from "../src/lib/accounts-export"
import { fmtLocalDateTime } from "../src/lib/format"

test("buildAccountsCsv formats last_request with the same local time string as the table", () => {
  const account: AdminAccountItem = {
    account_id: "acct-1",
    account_type: "free",
    runtime: { failed: false },
    stats: {
      since_ms: Date.parse("2026-04-01T00:00:00"),
      request_count: 3,
      error_count: 1,
      tokens_total: 42,
      avg_duration_ms: 1234,
      last_request_at_ms: Date.parse("2026-04-15T13:45:23"),
    },
  }

  const csv = buildAccountsCsv([account])

  expect(csv).toContain(`"${fmtLocalDateTime(account.stats?.last_request_at_ms)}"`)
})

test("getAccountsCsvFilename uses the browser local date instead of UTC", () => {
  const now = new Date(2026, 3, 15, 23, 30, 0)

  expect(getAccountsCsvFilename(now)).toBe("accounts-2026-04-15.csv")
})
