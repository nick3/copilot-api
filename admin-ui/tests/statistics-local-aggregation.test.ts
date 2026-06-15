import { expect, test } from "bun:test"

import {
  aggregateHourlyAccountStatsToLocalDays,
  aggregateHourlyStatsToLocalDays,
} from "../src/lib/statistics-local-aggregation"

test("aggregateHourlyStatsToLocalDays folds UTC buckets into the browser local day", () => {
  const result = aggregateHourlyStatsToLocalDays(
    [
      {
        date: "2026-04-14T16:00:00Z",
        request_count: 1,
        premium_consumed: 2,
        credits_consumed: 2,
        tokens_total: 3,
        error_count: 0,
      },
      {
        date: "2026-04-15T15:00:00Z",
        request_count: 4,
        premium_consumed: 5,
        credits_consumed: 5,
        tokens_total: 6,
        error_count: 1,
      },
    ],
    "Asia/Shanghai",
  )

  expect(result).toEqual([
    {
      date: "2026-04-15",
      request_count: 5,
      premium_consumed: 7,
      credits_consumed: 7,
      tokens_total: 9,
      error_count: 1,
    },
  ])
})

test("aggregateHourlyAccountStatsToLocalDays keeps account splits while folding by local day", () => {
  const result = aggregateHourlyAccountStatsToLocalDays(
    [
      {
        date: "2026-04-14T16:00:00Z",
        account_id: "acct-a",
        request_count: 1,
        premium_consumed: 2,
        credits_consumed: 2,
        tokens_total: 3,
        error_count: 0,
      },
      {
        date: "2026-04-15T01:00:00Z",
        account_id: "acct-b",
        request_count: 4,
        premium_consumed: 5,
        credits_consumed: 5,
        tokens_total: 6,
        error_count: 1,
      },
      {
        date: "2026-04-15T15:00:00Z",
        account_id: "acct-a",
        request_count: 7,
        premium_consumed: 8,
        credits_consumed: 8,
        tokens_total: 9,
        error_count: 1,
      },
    ],
    "Asia/Shanghai",
  )

  expect(result).toEqual([
    {
      date: "2026-04-15",
      account_id: "acct-a",
      request_count: 8,
      premium_consumed: 10,
      credits_consumed: 10,
      tokens_total: 12,
      error_count: 1,
    },
    {
      date: "2026-04-15",
      account_id: "acct-b",
      request_count: 4,
      premium_consumed: 5,
      credits_consumed: 5,
      tokens_total: 6,
      error_count: 1,
    },
  ])
})
