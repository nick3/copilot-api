import { expect, test } from "bun:test";

async function loadRangeModule() {
  return (await import("../src/lib/statistics-range").catch(() => null)) as
    | null
    | typeof import("../src/lib/statistics-range");
}

test("resolveStatisticsRange maps today preset to a same-day hourly range", async () => {
  const fixedNow = new Date("2026-04-15T13:45:00");
  const mod = await loadRangeModule();

  expect(
    mod?.resolveStatisticsRange({
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
    mod?.resolveStatisticsRange({
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
