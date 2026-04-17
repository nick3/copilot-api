import { expect, test } from "bun:test"

import { isCapture4xxEnabled, isDevModeEnabled } from "~/lib/dev-mode"

test("isDevModeEnabled defaults to false", () => {
  // getConfig() reads from disk; default config has devMode.enabled = false
  expect(isDevModeEnabled()).toBe(false)
})

test("isCapture4xxEnabled defaults to false", () => {
  expect(isCapture4xxEnabled()).toBe(false)
})
