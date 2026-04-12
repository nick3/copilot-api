import { expect, test } from "bun:test"

import { getRefreshDeadlineMs, getRefreshPollDelayMs } from "../src/lib/token"

test("builds refresh deadline from refresh_in and local time", () => {
  const nowMs = 1_000_000

  expect(getRefreshDeadlineMs(1_800, nowMs)).toBe(nowMs + 1_740_000)
})

test("clamps refresh deadline to avoid a hot loop", () => {
  const nowMs = 1_000_000

  expect(getRefreshDeadlineMs(30, nowMs)).toBe(nowMs + 1_000)
})

test("caps poll delay at 15 seconds while waiting", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs + 120_000, nowMs)).toBe(15_000)
})

test("uses remaining delay when refresh is close", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs + 8_000, nowMs)).toBe(8_000)
})

test("returns zero when refresh is already due", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs - 1, nowMs)).toBe(0)
})
