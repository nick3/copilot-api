import { expect, test } from "bun:test"

import {
  localInputToFromMs,
  localInputToToMs,
  msToLocalInput,
} from "../src/lib/requests-time-range"

test("localInputToFromMs keeps the selected minute start", () => {
  const value = "2026-04-15T13:45"

  expect(localInputToFromMs(value)).toBe(String(Date.parse(value)))
})

test("localInputToToMs expands the selected minute to the inclusive end", () => {
  const value = "2026-04-15T13:45"

  expect(localInputToToMs(value)).toBe(String(Date.parse(value) + 59_999))
})

test("msToLocalInput formats milliseconds as a datetime-local value", () => {
  const value = "2026-04-15T13:45"

  expect(msToLocalInput(String(Date.parse(value) + 42_000))).toBe(value)
})
