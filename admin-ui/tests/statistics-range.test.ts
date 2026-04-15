import { expect, test } from "bun:test";

async function loadRangeModule() {
  return import("../src/lib/statistics-range");
}

test("resolveStatisticsRange maps today preset to a same-day hourly range", async () => {
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
  });
});

test("resolveStatisticsRange keeps 7d as a daily calendar range", async () => {
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
    from: "2026-04-08",
    to: "2026-04-15",
    granularity: "day",
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
  });
});
