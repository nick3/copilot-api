import { afterEach, expect, spyOn, test } from "bun:test"

import * as config from "~/lib/config"
import { isCapture4xxEnabled, isDevModeEnabled } from "~/lib/dev-mode"

let configSpy: ReturnType<typeof spyOn<typeof config, "getConfig">> | null =
  null

afterEach(() => {
  configSpy?.mockRestore()
  configSpy = null
})

test("isDevModeEnabled returns false when devMode is undefined", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({} as config.AppConfig)
  expect(isDevModeEnabled()).toBe(false)
})

test("isCapture4xxEnabled returns false when devMode is undefined", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({} as config.AppConfig)
  expect(isCapture4xxEnabled()).toBe(false)
})

test("isDevModeEnabled returns true when enabled", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({
    devMode: { enabled: true, capture4xx: false },
  } as config.AppConfig)
  expect(isDevModeEnabled()).toBe(true)
})

test("isCapture4xxEnabled returns true when capture4xx is true", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({
    devMode: { enabled: false, capture4xx: true },
  } as config.AppConfig)
  expect(isCapture4xxEnabled()).toBe(true)
})
