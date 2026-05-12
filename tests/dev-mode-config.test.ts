import { afterEach, expect, spyOn, test } from "bun:test"

import * as config from "~/lib/config"
import {
  isCapture4xxEnabled,
  isCapture5xxEnabled,
  isCaptureOtherEnabled,
  isDevModeEnabled,
} from "~/lib/dev-mode"

let configSpy: ReturnType<typeof spyOn<typeof config, "getConfig">> | null =
  null

afterEach(() => {
  configSpy?.mockRestore()
  configSpy = null
})

test("isDevModeEnabled returns false when devMode is undefined", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({})
  expect(isDevModeEnabled()).toBe(false)
})

test("isCapture4xxEnabled returns false when devMode is undefined", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({})
  expect(isCapture4xxEnabled()).toBe(false)
})

test("isDevModeEnabled returns true when enabled", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({
    devMode: {
      enabled: true,
      capture4xx: false,
      capture5xx: false,
      captureOther: false,
    },
  })
  expect(isDevModeEnabled()).toBe(true)
})

test("isCapture4xxEnabled returns true when capture4xx is true", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({
    devMode: {
      enabled: false,
      capture4xx: true,
      capture5xx: false,
      captureOther: false,
    },
  })
  expect(isCapture4xxEnabled()).toBe(true)
})

test("isCapture5xxEnabled returns false when devMode is undefined", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({})
  expect(isCapture5xxEnabled()).toBe(false)
})

test("isCapture5xxEnabled returns true when capture5xx is true", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({
    devMode: {
      enabled: true,
      capture4xx: false,
      capture5xx: true,
      captureOther: false,
    },
  })
  expect(isCapture5xxEnabled()).toBe(true)
})

test("isCaptureOtherEnabled returns false when devMode is undefined", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({})
  expect(isCaptureOtherEnabled()).toBe(false)
})

test("isCaptureOtherEnabled returns true when captureOther is true", () => {
  configSpy = spyOn(config, "getConfig").mockReturnValue({
    devMode: {
      enabled: true,
      capture4xx: false,
      capture5xx: false,
      captureOther: true,
    },
  })
  expect(isCaptureOtherEnabled()).toBe(true)
})
