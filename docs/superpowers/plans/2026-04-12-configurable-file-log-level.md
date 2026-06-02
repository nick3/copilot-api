# Configurable File Log Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户通过 `config.json.logLevel` 明确控制 handler 文件日志的发射与落盘级别，并复用现有 `/api/admin/config` 配置入口与测试体系。

**Architecture:** 在 `src/lib/config.ts` 中把 `logLevel` 提升为一等配置，提供默认值合并与读取 helper；`src/lib/logger.ts` 统一将 `consola` 的 log type 映射到文件级别，同时让 heavy debug helper 和 direct `logger.debug(...)` 都受同一配置约束；`src/routes/admin-api/route.ts` 只负责校验与写回该字段，README 文档同步说明 `logLevel` 与 `--verbose` 的新边界。

**Tech Stack:** TypeScript、Bun test、Hono admin API、Consola、自定义 file reporter

**Git note:** 本计划故意省略 commit 步骤。只有在用户明确要求时才创建 git commit。

---

## File map

### Modified files
- `src/lib/config.ts` — 新增 `LogLevel` 类型、`logLevel` 配置项、默认值合并和 `getLogLevel()` helper
- `src/lib/logger.ts` — 新增文件日志级别映射、direct `logger.debug(...)` 过滤、`debugJson*` gating，以及测试可观测 helper
- `src/routes/admin-api/route.ts` — 扩展 `CONFIG_KEYS`、`CONFIG_PATCH_HANDLERS` 和 `logLevel` 校验逻辑
- `tests/admin-config.test.ts` — 覆盖 `logLevel` 的默认值、合法写入、非法字符串和非法类型拒绝
- `tests/logger.test.ts` — 覆盖 `debugJson*`、`debugJsonTail()`、`shouldWriteFileLog()` 和 `createHandlerLogger()` 的 direct debug 路径
- `README.md` — 在 `config.json` 配置说明中补充 `logLevel` 字段和 `--verbose`/文件日志边界
- `README_CN.md` — 同步中文配置说明和默认 JSON

### Leave untouched unless a task proves otherwise
- `src/start.ts`
- `src/server.ts`
- `src/routes/messages/handler.ts`
- `src/routes/responses/handler.ts`
- `src/routes/chat-completions/handler.ts`

---

## Task 1: Add `logLevel` to config and the Admin config API

**Files:**
- Modify: `src/lib/config.ts:6-33,94-123,195-372,390-392`
- Modify: `src/routes/admin-api/route.ts:172-192,226-258,968-1022`
- Test: `tests/admin-config.test.ts:36-170`

- [ ] **Step 1: Add failing admin config tests for the new field**

```ts
// tests/admin-config.test.ts
import { getLogLevel, mergeConfigWithDefaults } from "~/lib/config"

test("GET /api/admin/config returns the merged default logLevel", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config"),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { logLevel?: string }
    expect(body.logLevel).toBe("info")
  })
})

test("POST /api/admin/config updates logLevel and subsequent reads", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const postRes = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ logLevel: "warn" }),
      }),
    )

    expect(postRes.status).toBe(200)

    const postBody = (await postRes.json()) as { logLevel?: string }
    expect(postBody.logLevel).toBe("warn")
    expect(getLogLevel()).toBe("warn")

    const getRes = await server.fetch(
      new Request("http://localhost/api/admin/config"),
    )

    expect(getRes.status).toBe(200)

    const getBody = (await getRes.json()) as { logLevel?: string }
    expect(getBody.logLevel).toBe("warn")
  })
})

test("POST /api/admin/config clears logLevel back to the merged default", async () => {
  await withConfig({ logLevel: "debug" }, async () => {
    const { server } = await import("../src/server")

    const postRes = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ logLevel: null }),
      }),
    )

    expect(postRes.status).toBe(200)

    const postBody = (await postRes.json()) as { logLevel?: string }
    expect(postBody.logLevel).toBe("info")
    expect(getLogLevel()).toBe("info")

    const getRes = await server.fetch(
      new Request("http://localhost/api/admin/config"),
    )

    expect(getRes.status).toBe(200)

    const getBody = (await getRes.json()) as { logLevel?: string }
    expect(getBody.logLevel).toBe("info")
  })
})

test("POST /api/admin/config rejects invalid string logLevel", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ logLevel: "trace" }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("logLevel")
  })
})

test("POST /api/admin/config rejects non-string logLevel", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ logLevel: true }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("logLevel")
  })
})
```

- [ ] **Step 2: Run the focused admin config test file and verify the new cases fail**

Run:

```bash
bun test "tests/admin-config.test.ts"
```

Expected:
- FAIL because `AppConfig` does not include `logLevel`
- FAIL because `/api/admin/config` rejects `logLevel` as an unknown config key
- Existing unrelated admin config tests still pass

- [ ] **Step 3: Implement `logLevel` in the config model and admin patch pipeline**

说明：`logLevel` 的 PATCH 行为与现有 admin config 约定保持一致——合法字符串写入、`null` / 空字符串清除持久化 override，其余非法类型继续报错；清除后读取值通过默认值合并回到 `"info"`。

```ts
// src/lib/config.ts
export type LogLevel = "error" | "warn" | "info" | "debug"

export interface AppConfig {
  auth?: {
    apiKeys?: Array<string>
  }
  providers?: Record<string, ProviderConfig>
  extraPrompts?: Record<string, string>
  smallModel?: string
  accountAffinity?: boolean
  /** @deprecated */
  apiKey?: string
  responsesApiContextManagementModels?: Array<string>
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >
  modelAliases?: Record<string, { target: string; allowOriginal?: boolean }>
  allowOriginalModelNamesForAliases?: boolean
  useFunctionApplyPatch?: boolean
  forceAgent?: boolean
  compactUseSmallModel?: boolean
  messageStartInputTokensFallback?: boolean
  modelRefreshIntervalHours?: number
  sessionAffinityRetentionDays?: number
  useMessagesApi?: boolean
  anthropicApiKey?: string
  useResponsesApiWebSearch?: boolean
  claudeTokenMultiplier?: number
  logLevel?: LogLevel
}

function normalizeLogLevel(value: unknown): LogLevel | undefined {
  switch (value) {
    case "error":
    case "warn":
    case "info":
    case "debug":
      return value
    default:
      return undefined
  }
}

const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  providers: {},
  extraPrompts: {
    "gpt-5-mini": gpt5ExplorationPrompt,
    "gpt-5.3-codex": gpt5CommentaryPrompt,
    "gpt-5.4-mini": gpt5CommentaryPrompt,
    "gpt-5.4": gpt5CommentaryPrompt,
  },
  smallModel: "gpt-5-mini",
  accountAffinity: true,
  responsesApiContextManagementModels: [],
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4-mini": "xhigh",
    "gpt-5.4": "xhigh",
  },
  allowOriginalModelNamesForAliases: false,
  useFunctionApplyPatch: true,
  forceAgent: false,
  compactUseSmallModel: true,
  messageStartInputTokensFallback: false,
  modelRefreshIntervalHours: 24,
  sessionAffinityRetentionDays: 7,
  useMessagesApi: true,
  useResponsesApiWebSearch: true,
  logLevel: "info",
}

function mergeDefaultLogLevel(config: AppConfig): ConfigMergeResult {
  const normalized = normalizeLogLevel(config.logLevel)

  if (normalized !== undefined) {
    if (config.logLevel === normalized) {
      return { mergedConfig: config, changed: false }
    }

    return {
      mergedConfig: {
        ...config,
        logLevel: normalized,
      },
      changed: true,
    }
  }

  return {
    mergedConfig: {
      ...config,
      logLevel: defaultConfig.logLevel ?? "info",
    },
    changed: true,
  }
}

export function mergeConfigWithDefaults(): AppConfig {
  const config = readConfigFromDisk()

  const { mergedConfig, changed } = applyConfigMerges(config, [
    mergeDefaultAuth,
    mergeDefaultConfig,
    mergeDefaultAccountAffinity,
    mergeDefaultModelRefreshInterval,
    mergeDefaultSessionAffinityRetention,
    mergeDefaultLogLevel,
  ])

  if (changed) {
    try {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(mergedConfig, null, 2)}\n`,
        "utf8",
      )
    } catch (writeError) {
      consola.warn("Failed to write merged config defaults", writeError)
    }
  }

  cachedConfig = mergedConfig
  return mergedConfig
}

export function getLogLevel(): LogLevel {
  const config = getConfig()
  return normalizeLogLevel(config.logLevel) ?? defaultConfig.logLevel ?? "info"
}
```

```ts
// src/routes/admin-api/route.ts
const CONFIG_KEYS = new Set<keyof AppConfig>([
  "auth",
  "extraPrompts",
  "smallModel",
  "accountAffinity",
  "apiKey",
  "anthropicApiKey",
  "providers",
  "responsesApiContextManagementModels",
  "modelReasoningEfforts",
  "modelAliases",
  "allowOriginalModelNamesForAliases",
  "useFunctionApplyPatch",
  "forceAgent",
  "compactUseSmallModel",
  "messageStartInputTokensFallback",
  "modelRefreshIntervalHours",
  "sessionAffinityRetentionDays",
  "useMessagesApi",
  "useResponsesApiWebSearch",
  "logLevel",
])

function applyOptionalLogLevel(
  next: AppConfig,
  field: "logLevel",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalString(value, field)
  if ("error" in parsed) return parsed.error

  if ("clear" in parsed) {
    delete next.logLevel
    return undefined
  }

  switch (parsed.value) {
    case "error":
    case "warn":
    case "info":
    case "debug":
      next.logLevel = parsed.value
      return undefined
    default:
      return `${field} must be one of error, warn, info, debug`
  }
}

const CONFIG_PATCH_HANDLERS: Partial<Record<string, ConfigPatchHandler>> = {
  auth: applyAuthConfig,
  extraPrompts: applyExtraPrompts,
  smallModel: (next, value) => applyOptionalString(next, "smallModel", value),
  accountAffinity: (next, value) =>
    applyOptionalBoolean(next, "accountAffinity", value),
  apiKey: (next, value) => applyOptionalString(next, "apiKey", value),
  anthropicApiKey: (next, value) =>
    applyOptionalString(next, "anthropicApiKey", value),
  providers: applyProvidersConfig,
  responsesApiContextManagementModels: applyResponsesApiContextManagementModels,
  modelReasoningEfforts: applyReasoningEfforts,
  modelAliases: applyModelAliases,
  allowOriginalModelNamesForAliases: (next, value) =>
    applyOptionalBoolean(next, "allowOriginalModelNamesForAliases", value),
  useFunctionApplyPatch: (next, value) =>
    applyOptionalBoolean(next, "useFunctionApplyPatch", value),
  forceAgent: (next, value) => applyOptionalBoolean(next, "forceAgent", value),
  compactUseSmallModel: (next, value) =>
    applyOptionalBoolean(next, "compactUseSmallModel", value),
  messageStartInputTokensFallback: (next, value) =>
    applyOptionalBoolean(next, "messageStartInputTokensFallback", value),
  modelRefreshIntervalHours: (next, value) =>
    applyOptionalNumber(next, "modelRefreshIntervalHours", value),
  sessionAffinityRetentionDays: (next, value) =>
    applyOptionalNumber(next, "sessionAffinityRetentionDays", value),
  useMessagesApi: (next, value) =>
    applyOptionalBoolean(next, "useMessagesApi", value),
  useResponsesApiWebSearch: (next, value) =>
    applyOptionalBoolean(next, "useResponsesApiWebSearch", value),
  logLevel: (next, value) => applyOptionalLogLevel(next, "logLevel", value),
}
```

- [ ] **Step 4: Re-run the focused admin config tests and verify the green state**

Run:

```bash
bun test "tests/admin-config.test.ts"
```

Expected:
- PASS for the new `GET /api/admin/config returns the merged default logLevel` case
- PASS for the `POST /api/admin/config updates logLevel and subsequent reads` case, including same-process `getLogLevel()` readback
- PASS for the `POST /api/admin/config clears logLevel back to the merged default` case
- PASS for both invalid `logLevel` rejection cases
- No regressions in the existing provider/auth/config tests

---

## Task 2: Rework file logger behavior around `logLevel`

**Files:**
- Modify: `src/lib/logger.ts:10-18,83-103,124-149,181-239`
- Test: `tests/logger.test.ts:1-49`
- Read only while implementing: `src/lib/config.ts` from Task 1

- [ ] **Step 1: Add failing logger tests for helper gating, `debugJsonTail()`, and direct `logger.debug(...)`**

```ts
// tests/logger.test.ts
import { afterEach, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { mergeConfigWithDefaults } from "~/lib/config"
import {
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  getBufferedLogLinesForTests,
  resetLoggerRuntimeForTests,
  shouldWriteFileLog,
} from "../src/lib/logger"
import { PATHS } from "~/lib/paths"
import { state } from "../src/lib/state"

type TestConfig = Record<string, unknown>

const withConfig = async (config: TestConfig, run: () => Promise<void>) => {
  const original = await fs.readFile(PATHS.CONFIG_PATH, "utf8").catch(() => null)

  await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
  await fs.writeFile(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()

  try {
    await run()
  } finally {
    state.verbose = false
    resetLoggerRuntimeForTests()

    if (original === null) {
      await fs.rm(PATHS.CONFIG_PATH, { force: true })
    } else {
      await fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    }

    mergeConfigWithDefaults()
  }
}

const expectFileLogMatrix = (expected: {
  error: boolean
  warn: boolean
  info: boolean
  debug: boolean
  log: boolean
  success: boolean
  unexpected: boolean
}) => {
  expect(shouldWriteFileLog("error")).toBe(expected.error)
  expect(shouldWriteFileLog("warn")).toBe(expected.warn)
  expect(shouldWriteFileLog("info")).toBe(expected.info)
  expect(shouldWriteFileLog("debug")).toBe(expected.debug)
  expect(shouldWriteFileLog("log")).toBe(expected.log)
  expect(shouldWriteFileLog("success")).toBe(expected.success)
  expect(shouldWriteFileLog("unexpected")).toBe(expected.unexpected)
}

afterEach(() => {
  state.verbose = false
  resetLoggerRuntimeForTests()
})

test("debugJson ignores verbose mode when logLevel is not debug", async () => {
  await withConfig({ logLevel: "info" }, async () => {
    state.verbose = true

    const logger = { debug: mock(() => {}) }
    const toJSON = mock(() => ({ ok: true }))

    debugJson(logger as never, "payload", { toJSON })

    expect(toJSON).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })
})

test("debugJson logs the serialized payload when logLevel is debug", async () => {
  await withConfig({ logLevel: "debug" }, async () => {
    const logger = { debug: mock(() => {}) }
    const payload = { ok: true }

    debugJson(logger as never, "payload", payload)

    expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
  })
})

test("debugJsonTail preserves tail truncation when logLevel is debug", async () => {
  await withConfig({ logLevel: "debug" }, async () => {
    const logger = { debug: mock(() => {}) }
    const payload = { text: "abcdefghijklmnopqrstuvwxyz" }

    debugJsonTail(logger as never, "payload", {
      value: payload,
      tailLength: 10,
    })

    expect(logger.debug).toHaveBeenCalledWith(
      "payload",
      JSON.stringify(payload).slice(-10),
    )
  })
})

test("shouldWriteFileLog honors every configured threshold", async () => {
  await withConfig({ logLevel: "error" }, async () => {
    expectFileLogMatrix({
      error: true,
      warn: false,
      info: false,
      debug: false,
      log: false,
      success: false,
      unexpected: false,
    })
  })

  await withConfig({ logLevel: "warn" }, async () => {
    expectFileLogMatrix({
      error: true,
      warn: true,
      info: false,
      debug: false,
      log: false,
      success: false,
      unexpected: false,
    })
  })

  await withConfig({ logLevel: "info" }, async () => {
    expectFileLogMatrix({
      error: true,
      warn: true,
      info: true,
      debug: false,
      log: true,
      success: true,
      unexpected: true,
    })
  })

  await withConfig({ logLevel: "debug" }, async () => {
    expectFileLogMatrix({
      error: true,
      warn: true,
      info: true,
      debug: true,
      log: true,
      success: true,
      unexpected: true,
    })
  })
})

test("createHandlerLogger suppresses direct debug lines when verbose is enabled but logLevel is info", async () => {
  await withConfig({ logLevel: "info" }, async () => {
    state.verbose = true

    const logger = createHandlerLogger("logger-test-info")

    logger.debug("hidden direct debug")

    expect(getBufferedLogLinesForTests().join("\n")).not.toContain(
      "hidden direct debug",
    )
  })
})

test("createHandlerLogger buffers direct debug lines when logLevel is debug", async () => {
  await withConfig({ logLevel: "debug" }, async () => {
    const logger = createHandlerLogger("logger-test-debug")

    logger.debug("visible direct debug")

    const content = getBufferedLogLinesForTests().join("\n")
    expect(content).toContain("visible direct debug")
    expect(content).toContain("[debug]")
  })
})
```

- [ ] **Step 2: Run the focused logger tests and verify the new cases fail**

Run:

```bash
bun test "tests/logger.test.ts"
```

Expected:
- FAIL because `shouldWriteFileLog` does not exist yet
- FAIL because `resetLoggerRuntimeForTests` and `getBufferedLogLinesForTests` do not exist yet
- FAIL because `debugJson()` still keys off `state.verbose`
- FAIL because direct `logger.debug(...)` behavior is not controlled by config

- [ ] **Step 3: Implement the logger-level mapping, helper gating, and test observability**

```ts
// src/lib/logger.ts
import { getLogLevel, type LogLevel } from "./config"

const FILE_LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

let exitHandler: (() => void) | undefined
let sigintHandler: (() => void) | undefined
let sigtermHandler: (() => void) | undefined

const normalizeLogTypeToLevel = (type: string): LogLevel => {
  switch (type) {
    case "error":
      return "error"
    case "warn":
      return "warn"
    case "debug":
      return "debug"
    case "info":
    case "log":
    case "success":
    default:
      return "info"
  }
}

export const shouldWriteFileLog = (type: string): boolean => {
  const configured = getLogLevel()
  return (
    FILE_LOG_LEVEL_PRIORITY[normalizeLogTypeToLevel(type)]
    <= FILE_LOG_LEVEL_PRIORITY[configured]
  )
}

const isFileDebugLoggingEnabled = (): boolean => getLogLevel() === "debug"

const detachProcessHandlers = () => {
  if (exitHandler) {
    process.off("exit", exitHandler)
    exitHandler = undefined
  }
  if (sigintHandler) {
    process.off("SIGINT", sigintHandler)
    sigintHandler = undefined
  }
  if (sigtermHandler) {
    process.off("SIGTERM", sigtermHandler)
    sigtermHandler = undefined
  }
}

const attachProcessHandlers = () => {
  if (exitHandler || sigintHandler || sigtermHandler) {
    return
  }

  exitHandler = cleanup
  sigintHandler = () => {
    cleanup()
    process.exit(0)
  }
  sigtermHandler = () => {
    cleanup()
    process.exit(0)
  }

  process.once("exit", exitHandler)
  process.once("SIGINT", sigintHandler)
  process.once("SIGTERM", sigtermHandler)
}

const initializeLoggerRuntime = () => {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  ensureLogDirectory()
  cleanupOldLogs()

  flushInterval = setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)
  maybeUnref(flushInterval)

  cleanupInterval = setInterval(cleanupOldLogs, CLEANUP_INTERVAL_MS)
  maybeUnref(cleanupInterval)

  attachProcessHandlers()
}

export const resetLoggerRuntimeForTests = (): void => {
  cleanup()
  detachProcessHandlers()
  runtimeInitialized = false
}

export const getBufferedLogLinesForTests = (): Array<string> =>
  [...logBuffers.values()].flatMap((buffer) => [...buffer])

export const debugLazy = (
  logger: DebugLogger,
  factory: () => [unknown, ...Array<unknown>],
): void => {
  if (!isFileDebugLoggingEnabled()) {
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

export const debugJsonTail = (
  logger: DebugLogger,
  label: string,
  { value, tailLength = 400 }: { value: unknown; tailLength?: number },
): void => {
  debugLazy(logger, () => [label, JSON.stringify(value).slice(-tailLength)])
}

export const createHandlerLogger = (name: string): ConsolaInstance => {
  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  instance.level = 5
  instance.setReporters([])

  instance.addReporter({
    log(logObj) {
      if (!shouldWriteFileLog(logObj.type)) {
        return
      }

      initializeLoggerRuntime()

      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(LOG_DIR, `${sanitizedName}-${dateKey}.log`)
      const message = formatArgs(logObj.args as Array<unknown>)
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      appendLine(filePath, line)
    },
  })

  return instance
}
```

- [ ] **Step 4: Re-run the focused logger tests and verify the green state**

Run:

```bash
bun test "tests/logger.test.ts"
```

Expected:
- PASS for the new `debugJson()` gating assertions, including `state.verbose = true` + `logLevel = "info"` 的解耦场景
- PASS for the `debugJsonTail()` 截断断言
- PASS for `shouldWriteFileLog()` 的 `error / warn / info / debug` 全矩阵与 `log` / `success` / 未知 type 映射断言
- PASS for both direct `createHandlerLogger()` debug-path assertions
- No regressions in the pre-existing logger tests

---

## Task 3: Document the new config and run final verification

**Files:**
- Modify: `README.md:333-418`
- Modify: `README_CN.md:313-372`
- Verify: `tests/admin-config.test.ts`, `tests/logger.test.ts`

- [ ] **Step 1: Update the English and Chinese config docs with `logLevel` and fully synced default JSON**

```md
<!-- README.md and README_CN.md: keep the default JSON aligned with src/lib/config.ts -->
{
  "auth": {
    "apiKeys": []
  },
  "providers": {},
  "extraPrompts": {
    "gpt-5-mini": "<built-in exploration prompt>",
    "gpt-5.3-codex": "<built-in commentary prompt>",
    "gpt-5.4-mini": "<built-in commentary prompt>",
    "gpt-5.4": "<built-in commentary prompt>"
  },
  "smallModel": "gpt-5-mini",
  "accountAffinity": true,
  "responsesApiContextManagementModels": [],
  "modelReasoningEfforts": {
    "gpt-5-mini": "low",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4-mini": "xhigh",
    "gpt-5.4": "xhigh"
  },
  "allowOriginalModelNamesForAliases": false,
  "useFunctionApplyPatch": true,
  "forceAgent": false,
  "compactUseSmallModel": true,
  "messageStartInputTokensFallback": false,
  "modelRefreshIntervalHours": 24,
  "sessionAffinityRetentionDays": 7,
  "useMessagesApi": true,
  "useResponsesApiWebSearch": true,
  "logLevel": "info"
}
```

```md
<!-- README.md / README_CN.md: add the field description and the new boundary -->
- **logLevel:** Controls handler file-log verbosity under `logs/*.log`. Allowed values are `error`, `warn`, `info`, and `debug`; defaults to `info`. Use `debug` if you need request/response payloads and stream-event diagnostics in file logs.
- **Important:** `--verbose` no longer implies debug-level file logging. Use `config.json` `logLevel: "debug"` when you want detailed file logs.
```

```md
<!-- README_CN.md: 同步中文说明 -->
- `logLevel`：控制 `logs/*.log` 下 handler 文件日志的详细级别；可选 `error`、`warn`、`info`、`debug`，默认 `info`。如需把请求/响应 payload、stream event 等详细调试内容写入文件，请显式配置 `"logLevel": "debug"`。
- 重要：`--verbose` 不再隐式开启 debug 级别文件日志；需要详细文件日志时请设置 `config.json` 的 `logLevel`。
```

- [ ] **Step 2: Run the focused regression suite for config + logger together**

Run:

```bash
bun test "tests/admin-config.test.ts" "tests/logger.test.ts"
```

Expected:
- PASS for the admin config `logLevel` cases
- PASS for the logger gating + direct debug-path cases
- No unrelated regressions in the two focused suites

- [ ] **Step 3: Run typecheck to catch signature/export regressions from the new helpers**

Run:

```bash
bun run typecheck
```

Expected:
- PASS with no TypeScript errors
- No missing exports/imports for `LogLevel`, `getLogLevel()`, `shouldWriteFileLog()`, or test helpers

- [ ] **Step 4: Run lint to catch style and unused-code regressions**

Run:

```bash
bun run lint
```

Expected:
- PASS with no new lint errors
- No unused imports / variables from the added helpers, tests, or doc-adjacent edits

- [ ] **Step 5: Run the production build for an end-to-end compile check**

Run:

```bash
bun run build
```

Expected:
- PASS for the server build and bundled admin UI build
- No final compile-time regressions from the new config field or logger exports

---

## Spec coverage check

- `logLevel` 作为 `config.json` 一等配置：Task 1 Step 3
- 默认值为 `info`：Task 1 Step 3 + Task 1 Step 4
- `/api/admin/config` 支持读写并拒绝非法字符串与非法类型：Task 1 Steps 1-4
- handler 文件日志与 `--verbose` 解耦：Task 2 Step 3
- `debugJson*` 由 `logLevel` 控制：Task 2 Steps 1-4
- `debugJsonTail()` 的截断语义保持不变：Task 2 Steps 1-4
- `log` / `success` / 未知 type 映射为 `info`：Task 2 Steps 1-4
- direct `logger.debug(...)` 受同一配置约束：Task 2 Steps 1-4
- README / README_CN 默认 JSON 与字段说明同步：Task 3 Step 1
- focused tests + typecheck + lint + build：Task 3 Steps 2-5

## Placeholder scan

- 无 “TODO / TBD / later” 占位内容
- 每个改动步骤都包含了目标文件、示例代码和验证命令
- 未使用“类似 Task N”之类的跳转式描述

## Type consistency check

- 配置字段名统一为 `logLevel`
- 类型名统一为 `LogLevel`
- logger helper 命名统一为 `shouldWriteFileLog()`、`resetLoggerRuntimeForTests()`、`getBufferedLogLinesForTests()`、`getLogLevel()`
- 文档、测试和实现片段都使用相同的 `error | warn | info | debug` 枚举值

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-12-configurable-file-log-level.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - 我分任务派发新的 subagent 按 task 实现，并在任务之间做两段式复核。
   - **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`
2. **Inline Execution** - 我在当前会话内按计划直接修改并验证，按 checkpoint 分批执行。
   - **REQUIRED SUB-SKILL:** `superpowers:executing-plans`

**Which approach?**
