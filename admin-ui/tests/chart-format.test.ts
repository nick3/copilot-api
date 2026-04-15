import { expect, test } from "bun:test"

async function loadModule() {
  return import("../src/lib/chart-format")
}

test("formatHourlyLabel shows HH:00 when showDate is false", async () => {
  const mod = await loadModule()
  // Construct a local-time Date, convert to UTC ISO, then format back
  const local = new Date(2026, 3, 15, 14, 0, 0)
  const utcIso = local.toISOString()
  expect(mod.formatHourlyLabel(utcIso, false)).toBe("14:00")
})

test("formatHourlyLabel shows MM-DD HH:00 when showDate is true", async () => {
  const mod = await loadModule()
  const local = new Date(2026, 3, 15, 14, 0, 0)
  const utcIso = local.toISOString()
  expect(mod.formatHourlyLabel(utcIso, true)).toBe("04-15 14:00")
})

test("formatHourlyLabel pads single-digit hours", async () => {
  const mod = await loadModule()
  const local = new Date(2026, 3, 15, 9, 0, 0)
  const utcIso = local.toISOString()
  expect(mod.formatHourlyLabel(utcIso, false)).toBe("09:00")
})

test("hourlyDataCrossesDays returns false for same-day data", async () => {
  const mod = await loadModule()
  const d1 = new Date(2026, 3, 15, 10, 0, 0).toISOString()
  const d2 = new Date(2026, 3, 15, 14, 0, 0).toISOString()
  expect(mod.hourlyDataCrossesDays([d1, d2])).toBe(false)
})

test("hourlyDataCrossesDays returns true for multi-day data", async () => {
  const mod = await loadModule()
  const d1 = new Date(2026, 3, 15, 23, 0, 0).toISOString()
  const d2 = new Date(2026, 3, 16, 1, 0, 0).toISOString()
  expect(mod.hourlyDataCrossesDays([d1, d2])).toBe(true)
})

test("hourlyDataCrossesDays returns false for empty array", async () => {
  const mod = await loadModule()
  expect(mod.hourlyDataCrossesDays([])).toBe(false)
})

test("formatHourlyTooltip shows full local date and time", async () => {
  const mod = await loadModule()
  const local = new Date(2026, 3, 15, 14, 0, 0)
  const utcIso = local.toISOString()
  expect(mod.formatHourlyTooltip(utcIso)).toBe("2026-04-15 14:00")
})

test("formatHourlyLabel can disambiguate repeated DST fallback hours with offsets", async () => {
  const mod = await loadModule()
  const beforeFallback = mod.formatHourlyLabel(
    "2026-11-01T05:00:00.000Z",
    true,
    { timeZone: "America/New_York", includeOffset: true },
  )
  const afterFallback = mod.formatHourlyLabel(
    "2026-11-01T06:00:00.000Z",
    true,
    { timeZone: "America/New_York", includeOffset: true },
  )

  expect(beforeFallback).toContain("11-01 01:00")
  expect(afterFallback).toContain("11-01 01:00")
  expect(beforeFallback).not.toBe(afterFallback)
})

test("formatDailyLabel extracts MM-DD from YYYY-MM-DD", async () => {
  const mod = await loadModule()
  expect(mod.formatDailyLabel("2026-04-15")).toBe("04-15")
  expect(mod.formatDailyLabel("2026-01-01")).toBe("01-01")
})
