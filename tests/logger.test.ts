import { afterEach, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { type LogLevel } from "../src/lib/config"
import {
  createHandlerLogger,
  debugJson,
  debugJsonLazy,
  debugJsonTail,
  getBufferedLogLinesForTests,
  normalizeLogTypeToLevel,
  resetLoggerRuntimeForTests,
  shouldWriteFileLog,
} from "../src/lib/logger"
import { state } from "../src/lib/state"

afterEach(() => {
  state.verbose = false
  resetLoggerRuntimeForTests()
})

test("debugJson skips serialization when logLevel is not debug even if verbose is enabled", () => {
  resetLoggerRuntimeForTests(undefined, "info")
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const toJSON = mock(() => ({ ok: true }))

  debugJson(logger as never, "payload", { toJSON })

  expect(toJSON).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJson logs the serialized payload when logLevel is debug", () => {
  resetLoggerRuntimeForTests(undefined, "debug")

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { ok: true }

  debugJson(logger as never, "payload", payload)

  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonLazy skips async payload creation when logLevel is not debug", async () => {
  resetLoggerRuntimeForTests(undefined, "info")

  const logger = {
    debug: mock(() => {}),
  }
  const factory = mock(() => Promise.resolve({ ok: true }))

  await debugJsonLazy(logger as never, "payload", factory)

  expect(factory).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJsonLazy logs async payloads when logLevel is debug", async () => {
  resetLoggerRuntimeForTests(undefined, "debug")

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { ok: true }
  const factory = mock(() => Promise.resolve(payload))

  await debugJsonLazy(logger as never, "payload", factory)

  expect(factory).toHaveBeenCalledTimes(1)
  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonTail preserves tail truncation behavior", () => {
  resetLoggerRuntimeForTests(undefined, "debug")

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { text: "abcdefghijklmnopqrstuvwxyz" }
  const expected = JSON.stringify(payload).slice(-10)

  debugJsonTail(logger as never, "payload", {
    value: payload,
    tailLength: 10,
  })

  expect(logger.debug).toHaveBeenCalledWith("payload", expected)
})

test("shouldWriteFileLog respects the error/warn/info/debug matrix", () => {
  const levels = ["error", "warn", "info", "debug"] as const
  const expectedMatrix: Record<LogLevel, Record<LogLevel, boolean>> = {
    error: { error: true, warn: false, info: false, debug: false },
    warn: { error: true, warn: true, info: false, debug: false },
    info: { error: true, warn: true, info: true, debug: false },
    debug: { error: true, warn: true, info: true, debug: true },
  }

  for (const configuredLevel of levels) {
    for (const logType of levels) {
      expect(shouldWriteFileLog(logType, configuredLevel)).toBe(
        expectedMatrix[configuredLevel][logType],
      )
    }
  }
})

test("normalizeLogTypeToLevel maps info-like log types to info", () => {
  expect(normalizeLogTypeToLevel("info")).toBe("info")
  expect(normalizeLogTypeToLevel("log")).toBe("info")
  expect(normalizeLogTypeToLevel("success")).toBe("info")
  expect(normalizeLogTypeToLevel("unknown")).toBe("info")
})

test("createHandlerLogger blocks direct debug file logs when verbose is enabled but logLevel is info", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logger-test-"))

  try {
    resetLoggerRuntimeForTests(tmpDir, "info")
    state.verbose = true

    const logger = createHandlerLogger("messages-handler-test")
    logger.debug("blocked direct debug")

    expect(getBufferedLogLinesForTests("messages-handler-test")).toEqual([])
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("createHandlerLogger writes direct debug file logs when logLevel is debug", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logger-test-"))

  try {
    resetLoggerRuntimeForTests(tmpDir, "debug")

    const logger = createHandlerLogger("messages-handler-test")
    logger.debug("allowed direct debug")

    const lines = getBufferedLogLinesForTests("messages-handler-test")

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("[debug]")
    expect(lines[0]).toContain("allowed direct debug")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})
