import { expect, test } from "bun:test";

async function loadRangeModule() {
  return import("../src/lib/statistics-range");
}

test("resolveStatisticsRange maps today preset to a same-day hourly range with fromMs/toMs", async () => {
  const fixedNow = new Date("2026-04-15T13:45:00");
  const mod = await loadRangeModule();

  expect(
    mod.resolveStatisticsRange({
      preset: "today",
      customFrom: "",
      customTo: "",
      now: fixedNow,
    }),
  ).toEqual({
    from: "2026-04-15",
    to: "2026-04-15",
    granularity: "hour",
    fromMs: new Date(2026, 3, 15).getTime(),
    toMs: new Date(2026, 3, 16).getTime() - 1,
  });
});

test("resolveStatisticsRange 7d includes today plus 6 prior days", async () => {
  const fixedNow = new Date("2026-04-15T13:45:00");
  const mod = await loadRangeModule();

  expect(
    mod.resolveStatisticsRange({
      preset: "7d",
      customFrom: "",
      customTo: "",
      now: fixedNow,
    }),
  ).toEqual({
    from: "2026-04-09",
    to: "2026-04-15",
    granularity: "day",
    fromMs: new Date(2026, 3, 9).getTime(),
    toMs: new Date(2026, 3, 16).getTime() - 1,
  });
});

test("resolveStatisticsRange maps month preset to the first day of the month", async () => {
  const fixedNow = new Date("2026-04-15T13:45:00");
  const mod = await loadRangeModule();

  expect(
    mod.resolveStatisticsRange({
      preset: "month",
      customFrom: "",
      customTo: "",
      now: fixedNow,
    }),
  ).toEqual({
    from: "2026-04-01",
    to: "2026-04-15",
    granularity: "day",
    fromMs: new Date(2026, 3, 1).getTime(),
    toMs: new Date(2026, 3, 16).getTime() - 1,
  });
});

test("resolveStatisticsRange uses custom dates when provided", async () => {
  const fixedNow = new Date("2026-04-15T13:45:00");
  const mod = await loadRangeModule();

  expect(
    mod.resolveStatisticsRange({
      preset: "custom",
      customFrom: "2026-03-01",
      customTo: "2026-03-31",
      now: fixedNow,
    }),
  ).toEqual({
    from: "2026-03-01",
    to: "2026-03-31",
    granularity: "day",
    fromMs: new Date(2026, 2, 1).getTime(),
    toMs: new Date(2026, 3, 1).getTime() - 1,
  });
});

test("validateCustomRange returns null for valid range (from <= to)", async () => {
  const mod = await loadRangeModule();
  expect(mod.validateCustomRange("2026-03-01", "2026-03-31")).toBeNull();
  expect(mod.validateCustomRange("2026-04-15", "2026-04-15")).toBeNull();
});

test("validateCustomRange returns error when from > to", async () => {
  const mod = await loadRangeModule();
  const error = mod.validateCustomRange("2026-04-15", "2026-04-01");
  expect(typeof error).toBe("string");
  expect(error).not.toBeNull();
});

test("validateCustomRange allows partial input so custom range can fall back to today", async () => {
  const mod = await loadRangeModule();
  expect(mod.validateCustomRange("", "2026-04-15")).toBeNull();
  expect(mod.validateCustomRange("2026-04-15", "")).toBeNull();
  expect(mod.validateCustomRange("", "")).toBeNull();
});

test("resolveStatisticsRange falls back missing custom dates to today", async () => {
  const fixedNow = new Date("2026-04-15T13:45:00");
  const mod = await loadRangeModule();

  expect(
    mod.resolveStatisticsRange({
      preset: "custom",
      customFrom: "",
      customTo: "",
      now: fixedNow,
    }),
  ).toEqual({
    from: "2026-04-15",
    to: "2026-04-15",
    granularity: "day",
    fromMs: new Date(2026, 3, 15).getTime(),
    toMs: new Date(2026, 3, 16).getTime() - 1,
  });
});

test("localDateEndMs computes end-of-day DST-safe", async () => {
  const mod = await loadRangeModule();
  // End of April 15 should be one ms before midnight April 16
  const expected = new Date(2026, 3, 16).getTime() - 1;
  expect(mod.localDateEndMs("2026-04-15")).toBe(expected);
});
