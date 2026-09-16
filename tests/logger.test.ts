import { afterEach, expect, mock, setSystemTime, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
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
  shutdownLoggerRuntime,
  shouldWriteFileLog,
} from "../src/lib/logger"
import { state } from "../src/lib/state"

const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"

afterEach(() => {
  delete process.env[LOG_DIR_ENV]
  shutdownLoggerRuntime()
  setSystemTime()
  state.verbose = false
  resetLoggerRuntimeForTests()
})

const localDate = (year: number, month: number, day: number): Date =>
  new Date(year, month - 1, day, 12)

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for logger state")
}

function trackLogStreams(): {
  restore: () => void
  streams: Array<fs.WriteStream>
} {
  const originalCreateWriteStream = fs.createWriteStream
  const streams: Array<fs.WriteStream> = []
  fs.createWriteStream = new Proxy(originalCreateWriteStream, {
    apply(target, thisArg, args) {
      const stream = Reflect.apply(target, thisArg, args) as fs.WriteStream
      streams.push(stream)
      return stream
    },
  })

  return {
    restore: () => {
      fs.createWriteStream = originalCreateWriteStream
    },
    streams,
  }
}

test("debugJson skips serialization when verbose logging is disabled", () => {
  state.verbose = false

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
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "logger-test-"))

  try {
    resetLoggerRuntimeForTests(tmpDir, "info")
    state.verbose = true

    const logger = createHandlerLogger("messages-handler-test")
    logger.debug("blocked direct debug")

    expect(getBufferedLogLinesForTests("messages-handler-test")).toEqual([])
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  }
})

test("createHandlerLogger writes direct debug file logs when logLevel is debug", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "logger-test-"))

  try {
    resetLoggerRuntimeForTests(tmpDir, "debug")

    const logger = createHandlerLogger("messages-handler-test")
    logger.debug("allowed direct debug")

    const lines = getBufferedLogLinesForTests("messages-handler-test")

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("[debug]")
    expect(lines[0]).toContain("allowed direct debug")
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  }
})

test("createHandlerLogger writes to COPILOT_API_LOG_DIR when set", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "logger-env-test-"))
  const previousLogDir = process.env.COPILOT_API_LOG_DIR
  process.env.COPILOT_API_LOG_DIR = tmpDir

  try {
    resetLoggerRuntimeForTests(undefined, "info")
    const logger = createHandlerLogger("env-override-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`line-${index}`)
    }

    const now = new Date()
    const dateKey = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-")
    const filePath = path.join(tmpDir, `env-override-handler-${dateKey}.log`)

    let content = ""
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        content = await fsp.readFile(filePath, "utf8")
      } catch {
        // The write stream opens asynchronously.
      }
      if (content.includes("line-99")) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(content).toContain("line-0")
    expect(content).toContain("line-99")
  } finally {
    shutdownLoggerRuntime()
    if (previousLogDir === undefined) {
      Reflect.deleteProperty(process.env, "COPILOT_API_LOG_DIR")
    } else {
      process.env.COPILOT_API_LOG_DIR = previousLogDir
    }
    await fsp.rm(tmpDir, { recursive: true, force: true })
  }
})

test("createHandlerLogger closes the previous stream when the date changes", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const trackedStreams = trackLogStreams()

  try {
    setSystemTime(localDate(2026, 1, 1))
    const logger = createHandlerLogger("rotating-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`first-day-${index}`)
    }

    const firstFilePath = path.join(logDir, "rotating-handler-2026-01-01.log")
    await waitFor(
      () =>
        trackedStreams.streams.length === 1
        && fs.existsSync(firstFilePath)
        && fs.readFileSync(firstFilePath, "utf8").includes("first-day-99"),
    )
    const firstStream = trackedStreams.streams[0]
    expect(firstStream.closed).toBe(false)

    setSystemTime(localDate(2026, 1, 2))
    for (let index = 0; index < 100; index += 1) {
      logger.error(`second-day-${index}`)
    }

    await waitFor(() => firstStream.closed)
    expect(firstStream.closed).toBe(true)

    const secondFilePath = path.join(logDir, "rotating-handler-2026-01-02.log")
    await waitFor(
      () =>
        fs.existsSync(secondFilePath)
        && fs.readFileSync(secondFilePath, "utf8").includes("second-day-99"),
    )
    expect(fs.readFileSync(secondFilePath, "utf8")).toContain("second-day-99")
  } finally {
    shutdownLoggerRuntime()
    trackedStreams.restore()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("logger startup removes expired files", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const filePath = path.join(logDir, "retention-handler-2026-01-01.log")
  const firstDate = localDate(2026, 1, 1)
  fs.writeFileSync(filePath, "expired\n", "utf8")
  fs.utimesSync(filePath, firstDate, firstDate)

  try {
    setSystemTime(localDate(2026, 1, 10))
    const logger = createHandlerLogger("retention-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`current-${index}`)
    }
    const currentFilePath = path.join(
      logDir,
      "retention-handler-2026-01-10.log",
    )

    await waitFor(
      () =>
        !fs.existsSync(filePath)
        && fs.existsSync(currentFilePath)
        && fs.readFileSync(currentFilePath, "utf8").includes("current-99"),
    )
    expect(fs.existsSync(filePath)).toBe(false)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("logger maintenance warns when an expired log cannot be removed", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const filePath = path.join(logDir, "blocked-handler-2026-01-01.log")
  const firstDate = localDate(2026, 1, 1)
  fs.writeFileSync(filePath, "blocked\n", "utf8")
  fs.utimesSync(filePath, firstDate, firstDate)
  setSystemTime(localDate(2026, 1, 10))

  const originalRmSync = fs.rmSync
  const originalWarn = console.warn
  const warnings: Array<Array<unknown>> = []
  fs.rmSync = new Proxy(originalRmSync, {
    apply(target, thisArg, args) {
      if (args[0] === filePath) {
        throw new Error("forced remove failure")
      }
      Reflect.apply(target, thisArg, args)
    },
  })
  console.warn = (...args: Array<unknown>) => {
    warnings.push(args)
  }

  try {
    const logger = createHandlerLogger("blocked-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`current-${index}`)
    }
    const currentFilePath = path.join(logDir, "blocked-handler-2026-01-10.log")
    await waitFor(
      () =>
        warnings.some(([message]) =>
          String(message).includes("Failed to remove old handler log"),
        )
        && fs.existsSync(currentFilePath)
        && fs.readFileSync(currentFilePath, "utf8").includes("current-99"),
    )

    expect(fs.existsSync(filePath)).toBe(true)
    expect(
      warnings.some(([message]) =>
        String(message).includes("Failed to remove old handler log"),
      ),
    ).toBe(true)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync = originalRmSync
    console.warn = originalWarn
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})
