import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { getLogLevel, type LogLevel } from "./config"
import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { requestContext } from "./request-context"

const LOG_RETENTION_DAYS = 7
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const DEFAULT_LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFER_SIZE = 100

const FILE_LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

// Mutable so tests can override the environment-derived directory.
let testLogDirOverride: string | undefined
// Test-only logLevel override; undefined means use getLogLevel() from config
let testLogLevelOverride: LogLevel | undefined

const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()

let runtimeInitialized = false
let flushInterval: ReturnType<typeof setInterval> | undefined
let cleanupInterval: ReturnType<typeof setInterval> | undefined
let currentLogDateKey: string | undefined

const getLogDir = (): string =>
  testLogDirOverride ?? (process.env[LOG_DIR_ENV]?.trim() || DEFAULT_LOG_DIR)

const ensureLogDirectory = () => {
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

const formatArgs = (args: Array<unknown>) =>
  args
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: null, colors: false })
      ),
    )
    .join(" ")

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

const getHandlerLogFilePath = (name: string, date: Date): string => {
  const dateKey = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
  return path.join(getLogDir(), `${sanitizeName(name)}-${dateKey}.log`)
}

const maybeUnref = (timer: ReturnType<typeof setInterval>) => {
  timer.unref()
}

const flushBuffer = (filePath: string) => {
  const buffer = logBuffers.get(filePath)
  if (!buffer) {
    return
  }

  logBuffers.delete(filePath)
  if (buffer.length === 0) {
    return
  }

  const stream = getLogStream(filePath)
  const content = buffer.join("\n") + "\n"
  stream.write(content, (error) => {
    if (error) {
      console.warn("Failed to write handler log", error)
    }
  })
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
}

const closeLogFile = async (filePath: string): Promise<void> => {
  flushBuffer(filePath)
  const stream = logStreams.get(filePath)
  logStreams.delete(filePath)
  logBuffers.delete(filePath)

  if (!stream || stream.closed) {
    return
  }

  await new Promise<void>((resolve) => {
    stream.once("close", resolve)
    stream.end()
  })
}

const closePreviousDateLogFiles = (dateKey: string): void => {
  if (currentLogDateKey === undefined) {
    currentLogDateKey = dateKey
    return
  }
  if (currentLogDateKey === dateKey) {
    return
  }

  const filePaths = new Set([...logBuffers.keys(), ...logStreams.keys()])
  currentLogDateKey = dateKey
  for (const filePath of filePaths) {
    void closeLogFile(filePath).catch((error) => {
      console.warn("Failed to rotate handler log", error)
    })
  }
}

const cleanupOldLogs = async (): Promise<void> => {
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) {
    return
  }

  const now = Date.now()
  for (const entry of fs.readdirSync(logDir)) {
    const filePath = path.join(logDir, entry)

    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }

    if (!stats.isFile() || now - stats.mtimeMs <= LOG_RETENTION_MS) {
      continue
    }

    try {
      await closeLogFile(filePath)
    } catch (error) {
      console.warn(`Failed to close old handler log: ${filePath}`, error)
      continue
    }

    try {
      fs.rmSync(filePath)
    } catch (error) {
      console.warn(`Failed to remove old handler log: ${filePath}`, error)
    }
  }
}

const scheduleLogCleanup = (): void => {
  void cleanupOldLogs().catch((error) => {
    console.warn("Failed to clean up handler logs", error)
  })
}

// Stops the background timers, flushes and closes all log streams, and resets
// runtime state so the logger can be initialized again. Runs on process exit
// and is also used by tests to release file handles before removing log dirs.
export const shutdownLoggerRuntime = () => {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = undefined
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = undefined
  }

  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }
  logStreams.clear()
  logBuffers.clear()
  runtimeInitialized = false
}

const initializeLoggerRuntime = () => {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  ensureLogDirectory()
  scheduleLogCleanup()

  flushInterval = setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)
  maybeUnref(flushInterval)

  cleanupInterval = setInterval(scheduleLogCleanup, CLEANUP_INTERVAL_MS)
  maybeUnref(cleanupInterval)

  registerProcessCleanup(shutdownLoggerRuntime)
}

const getLogStream = (filePath: string): fs.WriteStream => {
  initializeLoggerRuntime()

  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    const createdStream = fs.createWriteStream(filePath, { flags: "a" })
    stream = createdStream
    logStreams.set(filePath, createdStream)

    createdStream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      if (logStreams.get(filePath) === createdStream) {
        logStreams.delete(filePath)
      }
    })
  }
  return stream
}

const appendLine = (filePath: string, line: string) => {
  let buffer = logBuffers.get(filePath)
  if (!buffer) {
    buffer = []
    logBuffers.set(filePath, buffer)
  }

  buffer.push(line)

  if (buffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer(filePath)
  }
}

export const normalizeLogTypeToLevel = (type: string | undefined): LogLevel => {
  switch (type) {
    case "error": {
      return "error"
    }
    case "warn": {
      return "warn"
    }
    case "debug": {
      return "debug"
    }
    default: {
      return "info"
    }
  }
}

export const shouldWriteFileLog = (
  type: string | undefined,
  logLevel: LogLevel = resolveLogLevel(),
): boolean => {
  const typeLevel = normalizeLogTypeToLevel(type)
  return FILE_LOG_LEVEL_PRIORITY[typeLevel] <= FILE_LOG_LEVEL_PRIORITY[logLevel]
}

const resolveLogLevel = (): LogLevel => testLogLevelOverride ?? getLogLevel()

const isDebugFileLoggingEnabled = (): boolean => resolveLogLevel() === "debug"

export const resetLoggerRuntimeForTests = (
  overrideLogDir?: string,
  logLevelOverride?: LogLevel,
): void => {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = undefined
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = undefined
  }

  for (const stream of logStreams.values()) {
    stream.destroy()
  }
  logStreams.clear()
  logBuffers.clear()

  runtimeInitialized = false
  testLogDirOverride = overrideLogDir
  testLogLevelOverride = logLevelOverride
}

export const getBufferedLogLinesForTests = (name: string): Array<string> => {
  const prefix = `${sanitizeName(name)}-`

  for (const [filePath, lines] of logBuffers.entries()) {
    if (path.basename(filePath).startsWith(prefix)) {
      return [...lines]
    }
  }

  return []
}

/** @deprecated use resetLoggerRuntimeForTests / getBufferedLogLinesForTests */
export const __loggerTestUtils = {
  getBufferedHandlerLogLines: getBufferedLogLinesForTests,
  resetBufferedLogs(): void {
    logBuffers.clear()
  },
}

type DebugLogger = Pick<ConsolaInstance, "debug">

type AsyncDebugValueFactory = () => Promise<unknown>

export const debugLazy = (
  logger: DebugLogger,
  factory: () => [unknown, ...Array<unknown>],
): void => {
  if (!isDebugFileLoggingEnabled()) {
    return
  }

  logger.debug(...factory())
}

export const debugJson = (
  logger: DebugLogger,
  label: string,
  value: unknown,
): void => {
  debugLazy(logger, () => [label, JSON.stringify(value)])
}

export const debugJsonLazy = async (
  logger: DebugLogger,
  label: string,
  factory: AsyncDebugValueFactory,
): Promise<void> => {
  if (!isDebugFileLoggingEnabled()) {
    return
  }

  logger.debug(label, JSON.stringify(await factory()))
}

export const debugJsonTail = (
  logger: DebugLogger,
  label: string,
  { value, tailLength = 400 }: { value: unknown; tailLength?: number },
): void => {
  debugLazy(logger, () => [label, JSON.stringify(value).slice(-tailLength)])
}

// Consola level mapping: 0=error, 1=warn, 2=info/log/success, 3=verbose, 4=debug, 5=trace
// Match the configured file log level so consola short-circuits irrelevant events before
// they reach the reporter. "info" intentionally maps to 2 so info/log/success still pass.
const getConsolaLevel = (): number => {
  const logLevel = resolveLogLevel()

  switch (logLevel) {
    case "error": {
      return 0
    }
    case "warn": {
      return 1
    }
    case "info": {
      return 2
    }
    case "debug": {
      return 4
    }
    default: {
      const exhaustiveCheck: never = logLevel
      return exhaustiveCheck
    }
  }
}

export const createHandlerLogger = (name: string): ConsolaInstance => {
  const instance = consola.withTag(name)

  Object.defineProperty(instance, "level", {
    get: getConsolaLevel,
    configurable: true,
  })

  instance.setReporters([])

  instance.addReporter({
    log(logObj) {
      const fileLogLevel = resolveLogLevel()
      if (!shouldWriteFileLog(logObj.type, fileLogLevel)) {
        return
      }

      initializeLoggerRuntime()

      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = getHandlerLogFilePath(name, date)
      const message = formatArgs(logObj.args as Array<unknown>)
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      closePreviousDateLogFiles(
        [date.getFullYear(), date.getMonth() + 1, date.getDate()].join("-"),
      )
      appendLine(filePath, line)
    },
  })

  return instance
}
