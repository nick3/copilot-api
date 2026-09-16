import { describe, expect, test } from "bun:test"

import {
  validatePeakPricing,
  validateUpstreamTransport,
  UPSTREAM_TRANSPORT_FIELDS,
} from "../shared/config-validation"
import { parseTokenUsagePeriod } from "~/lib/token-usage/period"

describe("transport settings", () => {
  test("accepts each positive integer and a partial/default configuration", () => {
    expect(validateUpstreamTransport({})).toBeUndefined()
    for (const field of UPSTREAM_TRANSPORT_FIELDS) {
      expect(validateUpstreamTransport({ [field]: 128 })).toBeUndefined()
      for (const value of [0, -1, 1.5, Infinity, NaN, "100", null]) {
        expect(validateUpstreamTransport({ [field]: value })).toContain(
          "positive integer",
        )
      }
    }
  })
  test("rejects unsupported fields, timer overflow and non-objects", () => {
    expect(
      validateUpstreamTransport({ headersTimeoutMs: 2_147_483_648 }),
    ).toContain("maximum timer")
    expect(validateUpstreamTransport({ unknown: 1 })).toContain("not supported")
    for (const value of [null, [], 10])
      expect(validateUpstreamTransport(value)).toContain("object")
  })
})

describe("peak pricing", () => {
  test("accepts UTC windows, wraparound and optional weekdays", () => {
    for (const value of [
      {},
      { offPeak: { input: 0, cachedInput: 0.1 } },
      { peakWindows: [{ startMinuteUtc: 0, endMinuteUtc: 1440 }] },
      {
        peakWindows: [
          { startMinuteUtc: 1380, endMinuteUtc: 120, weekdays: [1, 7] },
        ],
      },
    ])
      expect(validatePeakPricing(value, "pricing")).toBeUndefined()
  })
  test("rejects malformed prices and nested fields", () => {
    for (const offPeak of [
      null,
      [],
      1,
      { input: -1 },
      { output: Infinity },
      { input: "1" },
      { tiers: [] },
    ]) {
      expect(validatePeakPricing({ offPeak }, "pricing")).toContain(
        "pricing.offPeak",
      )
    }
  })
  test("rejects malformed windows, ranges and weekdays", () => {
    expect(validatePeakPricing({ peakWindows: {} }, "pricing")).toContain(
      "array",
    )
    for (const window of [
      null,
      [],
      { startMinuteUtc: 0 },
      { startMinuteUtc: 0, endMinuteUtc: 1441 },
      { startMinuteUtc: 1440, endMinuteUtc: 0 },
      { startMinuteUtc: 0.5, endMinuteUtc: 10 },
      { startMinuteUtc: 0, endMinuteUtc: 10, weekdays: [0] },
      { startMinuteUtc: 0, endMinuteUtc: 10, weekdays: [8] },
      { startMinuteUtc: 0, endMinuteUtc: 10, weekdays: "Monday" },
      { startMinuteUtc: 0, endMinuteUtc: 10, timezone: "UTC" },
    ])
      expect(
        validatePeakPricing({ peakWindows: [window] }, "pricing"),
      ).toContain("pricing.peakWindows[0]")
  })
})

test("both usage APIs share calendar periods and legacy rolling aliases", () => {
  for (const period of [
    "today",
    "this_week",
    "last_7_days",
    "this_month",
    "last_30_days",
    "lifetime",
  ] as const) {
    expect(parseTokenUsagePeriod(period)).toBe(period)
  }
  expect(parseTokenUsagePeriod("day")).toBe("today")
  expect(parseTokenUsagePeriod("week")).toBe("last_7_days")
  expect(parseTokenUsagePeriod("month")).toBe("last_30_days")
  for (const period of [null, undefined, "", "invalid"])
    expect(parseTokenUsagePeriod(period)).toBe("today")
})
