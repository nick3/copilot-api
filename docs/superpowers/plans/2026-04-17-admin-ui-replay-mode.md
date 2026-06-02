# Admin-UI Developer Mode: Request Replay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Admin-UI 中新增"开发者模式"，允许对历史中返回 4xx 的上游请求进行可交互重放（修改 body + 业务头 + 切换账号），结果不入主历史库。

**Architecture:** 新增 `request_outbound` blob 表（FK CASCADE 链接 `request_log`）；统一上游调用到 `copilotFetch` helper，在 4xx 条件下 tee 响应并异步持久化；新增三个 admin 端点（dev-mode / outbound / replay）受 `devMode.enabled` 后端硬门闩保护；Admin-UI 增独立路由 `/requests/:id/replay` 提供 body + 业务头编辑器与响应双视图（Raw / Translated），支持 collect 与 live SSE 两种响应策略。

**Tech Stack:** Bun + TypeScript (strict) · Hono · bun:sqlite · React + React Router + Vite · shadcn/ui · sonner · i18next · `@echristian/eslint-config`。

**Spec:** `docs/superpowers/specs/2026-04-17-admin-ui-replay-mode-design.md`

**Target branch:** `all`（所有 PR 指向 `nick3/copilot-api:all`）

---

## 全局约定

- 所有 shell 命令默认在仓库根目录 `/Volumes/Nick-OMV-Storage/Workspace/copilot-api` 执行。
- 运行 `bun test <file>` 可以跑单个测试；`bun run lint`、`bun run typecheck`、`bun run build` 为整仓级。
- 全部新代码遵循 `@echristian/eslint-config` + 严格 TypeScript（`strict: true`、`noUnusedLocals`、`noUnusedParameters`）；禁止 `any`。
- Import 路径在 `src/**` 下用 `~/*` 别名；在 `admin-ui/src/**` 下用 `@/*` 别名。
- commit 信息遵循 conventional commits（`feat:` / `fix:` / `test:` / `refactor:` / `docs:` / `chore:`）；前缀中文禁用。
- **禁止在未获用户许可时执行 `git push` 或创建 PR**——本计划仅生成本地 commits。
- TDD：每个功能模块"先写失败测试 → 看失败 → 最小实现 → 看通过 → commit"。

---

## 文件结构

### 新增

| 路径 | 职责 |
|---|---|
| `src/lib/request-outbound.ts` | blob 表 CRUD + 脱敏白名单；单例 store |
| `src/lib/dev-mode.ts` | 读/写 `config.devMode`；`isDevModeEnabled()` / `isCapture4xxEnabled()` 等 helper |
| `src/services/copilot/copilot-fetch.ts` | 统一上游调用 helper：snapshot → fetch → 条件 tee → 异步写 blob |
| `src/routes/admin-api/replay.ts` | 挂 `dev-mode` / `requests/:id/outbound` / `requests/:id/replay` 子路由 |
| `tests/request-outbound-store.test.ts` | store + 脱敏单测 |
| `tests/outbound-redaction.test.ts` | 真实 header fixture 脱敏断言 |
| `tests/copilot-fetch.test.ts` | helper 的所有分支 |
| `tests/dev-mode-config.test.ts` | config 开关读写 |
| `tests/replay-handler.test.ts` | 重放端点行为矩阵 |
| `tests/replay-stream.test.ts` | live 模式 SSE 事件序列 |
| `tests/admin-db-migrations.test.ts` | v10 → v11 升级 + FK CASCADE |
| `admin-ui/src/lib/sse.ts` | 前端 SSE 解析 util |
| `admin-ui/src/pages/request-replay-page.tsx` | 重放路由容器 |
| `admin-ui/src/components/replay/replay-context-card.tsx` | 只读上下文展示 |
| `admin-ui/src/components/replay/replay-account-select.tsx` | 账号下拉 |
| `admin-ui/src/components/replay/replay-headers-editor.tsx` | header 编辑器 |
| `admin-ui/src/components/replay/replay-body-editor.tsx` | body 编辑器（json / text / binary 分支） |
| `admin-ui/src/components/replay/replay-response-panel.tsx` | 响应面板（Tabs） |

### 修改

| 路径 | 变更点 |
|---|---|
| `src/lib/admin-db.ts` | 新增 `migrateV11`，建 `request_outbound` 表 + 索引；在 `migrateAdminDb` 分派中接入；扩展孤儿清理 |
| `src/lib/config.ts` | 新增 `DevModeConfig` 类型 + `AppConfig.devMode`；新增 `mergeDefaultDevMode`；新增 `isDevModeEnabled()` / `isCapture4xxEnabled()` 的 re-export（或移至 dev-mode.ts） |
| `src/services/copilot/create-messages.ts` | 增加 `requestId` 参数；`fetch(...)` → `copilotFetch(...)` |
| `src/services/copilot/create-chat-completions.ts` | 同上 |
| `src/services/copilot/create-responses.ts` | 同上 |
| `src/services/copilot/create-embeddings.ts` | 同上；`capturable: false` |
| `src/services/copilot/get-models.ts` | 同上；`capturable: false` |
| `src/routes/messages/handler.ts` + 同类 handler | 把 `request_id` 传给 service 方法 |
| `src/routes/admin-api/route.ts` | 扩展 CONFIG_KEYS + CONFIG_PATCH_HANDLERS 支持 `devMode`；挂载 `replay.ts` 子路由；为 `/requests/:id` 响应添加 `has_outbound: boolean` 字段 |
| `src/lib/request-history.ts` | `cleanupRetention()` 额外运行 `outboundStore.cleanupOrphans()` |
| `admin-ui/src/App.tsx` | 注册 `/requests/:requestId/replay` |
| `admin-ui/src/lib/admin-api.ts` | 新增 `getDevMode` / `setDevMode` / `getRequestOutbound` / `replayCollect` / `replayLive` |
| `admin-ui/src/pages/request-detail-page.tsx` | 加 Replay 按钮 + 条件显示 |
| `admin-ui/src/pages/settings-page.tsx` | 加 Developer Mode 区块 |
| `admin-ui/src/locales/en.json` / `zh.json` | `replayPage.*`、`settingsPage.devMode.*`、`requestDetailPage.replay.*` |

---

## Task 1 — admin-db migration v11：新增 `request_outbound` 表

**Files:**
- Modify: `src/lib/admin-db.ts`
- Create: `tests/admin-db-migrations.test.ts`

- [ ] **Step 1：查阅当前最高 migration**

阅读 `src/lib/admin-db.ts`，确认 `migrateAdminDb()` 目前在 V10 结束。本任务新增 V11。

- [ ] **Step 2：写失败测试**

Create `tests/admin-db-migrations.test.ts`：

```ts
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import { initAdminDb } from "~/lib/admin-db"

function countTable(db: Database, name: string): number {
  const row = db
    .query(
      `SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?;`,
    )
    .get(name) as { c: number }
  return row.c
}

test("migrateV11 creates request_outbound with FK cascade", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  expect(countTable(db, "request_outbound")).toBe(1)

  const version = (
    db.query("PRAGMA user_version;").get() as { user_version: number }
  ).user_version
  expect(version).toBeGreaterThanOrEqual(11)

  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream)
     VALUES ('req-1', 1, 'POST', '/v1/messages', 0);`,
  )
  db.run(
    `INSERT INTO request_outbound (
       request_id, captured_at_ms, http_status,
       upstream_url, upstream_method,
       request_headers, request_body, request_body_kind,
       response_status, response_headers, response_body, response_body_kind
     ) VALUES ('req-1', 1, 400, 'https://x', 'POST', '{}', null, 'json', 400, '{}', null, 'json');`,
  )

  expect(
    (
      db
        .query("SELECT count(*) AS c FROM request_outbound;")
        .get() as { c: number }
    ).c,
  ).toBe(1)

  db.run("DELETE FROM request_log WHERE request_id = 'req-1';")

  expect(
    (
      db
        .query("SELECT count(*) AS c FROM request_outbound;")
        .get() as { c: number }
    ).c,
  ).toBe(0)
})
```

- [ ] **Step 3：运行测试，确认失败**

Run: `bun test tests/admin-db-migrations.test.ts`
Expected: FAIL（`request_outbound` 表不存在）

- [ ] **Step 4：新增 migrateV11**

在 `src/lib/admin-db.ts`（migration 分派函数）中追加：

```ts
function migrateV11(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS request_outbound (
      request_id         TEXT PRIMARY KEY,
      captured_at_ms     INTEGER NOT NULL,
      http_status        INTEGER NOT NULL,

      upstream_url       TEXT NOT NULL,
      upstream_method    TEXT NOT NULL,

      request_headers    TEXT NOT NULL,
      request_body       TEXT,
      request_body_kind  TEXT NOT NULL,

      response_status    INTEGER NOT NULL,
      response_headers   TEXT NOT NULL,
      response_body      TEXT,
      response_body_kind TEXT NOT NULL,

      FOREIGN KEY (request_id) REFERENCES request_log(request_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_request_outbound_captured_at
      ON request_outbound(captured_at_ms DESC);

    PRAGMA user_version = 11;
  `)
}
```

然后在现有的 migration 分派链（目前在 `migrateV8ToV11` 或等价位置；阅读已有代码决定）里，当 `current < 11` 时调用 `migrateV11(db)`。如现有分派名为 `migrateV8ToV10`，将它改名为 `migrateV8ToV11` 并在内部追加 `if (current < 11) migrateV11(db)`。

- [ ] **Step 5：运行测试，确认通过**

Run: `bun test tests/admin-db-migrations.test.ts`
Expected: PASS

- [ ] **Step 6：运行全量 lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: 无新增 error

- [ ] **Step 7：commit**

```bash
git add src/lib/admin-db.ts tests/admin-db-migrations.test.ts
git commit -m "feat(admin-db): add request_outbound table with FK cascade (migration v11)"
```

---

## Task 2 — `RequestOutboundStore`：blob 表 CRUD + 脱敏

**Files:**
- Create: `src/lib/request-outbound.ts`
- Create: `tests/request-outbound-store.test.ts`
- Create: `tests/outbound-redaction.test.ts`

- [ ] **Step 1：写 store 的失败测试**

Create `tests/request-outbound-store.test.ts`：

```ts
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import { initAdminDb } from "~/lib/admin-db"
import {
  createRequestOutboundStore,
  type OutboundCaptureInput,
} from "~/lib/request-outbound"

function seedLog(db: Database, requestId: string): void {
  db.run(
    `INSERT INTO request_log (request_id, started_at_ms, method, path, stream)
     VALUES (?, 1, 'POST', '/v1/messages', 0);`,
    [requestId],
  )
}

function makeInput(overrides: Partial<OutboundCaptureInput>): OutboundCaptureInput {
  return {
    requestId: "req-1",
    httpStatus: 400,
    upstreamUrl: "https://api.githubcopilot.com/v1/messages",
    upstreamMethod: "POST",
    requestHeaders: {
      Authorization: "Bearer REAL_TOKEN",
      "x-request-id": "abc",
    },
    requestBody: '{"model":"x"}',
    requestBodyKind: "json",
    responseStatus: 400,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"error":"bad request"}',
    responseBodyKind: "json",
    ...overrides,
  }
}

test("insert + getByRequestId round-trips and redacts Authorization", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  seedLog(db, "req-1")

  const store = createRequestOutboundStore(db)
  store.insert(makeInput({}))

  const row = store.getByRequestId("req-1")
  expect(row).not.toBeNull()
  expect(row!.requestHeaders["Authorization"]).toBe("***")
  expect(row!.requestHeaders["x-request-id"]).toBe("abc")
  expect(row!.requestBody).toBe('{"model":"x"}')
  expect(row!.responseStatus).toBe(400)
})

test("cleanupOrphans removes rows whose request_log entry is gone", () => {
  const db = new Database(":memory:")
  initAdminDb(db)
  seedLog(db, "req-orphan")

  const store = createRequestOutboundStore(db)
  store.insert(makeInput({ requestId: "req-orphan" }))

  // Simulate older DB without CASCADE by manually deleting from request_log only
  db.run("PRAGMA foreign_keys = OFF;")
  db.run("DELETE FROM request_log WHERE request_id = 'req-orphan';")
  db.run("PRAGMA foreign_keys = ON;")

  expect(store.getByRequestId("req-orphan")).not.toBeNull()
  store.cleanupOrphans()
  expect(store.getByRequestId("req-orphan")).toBeNull()
})

test("getByRequestId returns null when missing", () => {
  const db = new Database(":memory:")
  initAdminDb(db)

  const store = createRequestOutboundStore(db)
  expect(store.getByRequestId("does-not-exist")).toBeNull()
})
```

Create `tests/outbound-redaction.test.ts`：

```ts
import { expect, test } from "bun:test"

import { redactHeaders } from "~/lib/request-outbound"

test("redacts authorization, token, secret, cookie, x-api-key", () => {
  const redacted = redactHeaders({
    Authorization: "Bearer x",
    authorization: "Bearer y",
    "x-github-token": "gh_z",
    "X-Api-Key": "secret",
    "my-custom-token": "t",
    "my-custom-secret": "s",
    cookie: "a=b",
    "set-cookie": "a=b",
    "proxy-authorization": "Basic foo",
    "x-request-id": "keep",
    "user-agent": "keep",
    "content-type": "keep",
  })

  for (const key of [
    "Authorization",
    "authorization",
    "x-github-token",
    "X-Api-Key",
    "my-custom-token",
    "my-custom-secret",
    "cookie",
    "set-cookie",
    "proxy-authorization",
  ]) {
    expect(redacted[key]).toBe("***")
  }

  expect(redacted["x-request-id"]).toBe("keep")
  expect(redacted["user-agent"]).toBe("keep")
  expect(redacted["content-type"]).toBe("keep")
})
```

- [ ] **Step 2：运行测试，确认失败**

Run: `bun test tests/request-outbound-store.test.ts tests/outbound-redaction.test.ts`
Expected: FAIL（`~/lib/request-outbound` 模块不存在）

- [ ] **Step 3：实现 `request-outbound.ts`**

Create `src/lib/request-outbound.ts`：

```ts
import type { Database } from "bun:sqlite"

import consola from "consola"

import { getAdminDb } from "./admin-db"

const SENSITIVE_HEADER_PATTERNS: Array<RegExp> = [
  /^authorization$/i,
  /^x-github-token$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^proxy-authorization$/i,
  /^x-api-key$/i,
  /-token$/i,
  /-secret$/i,
]

export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_PATTERNS.some((re) => re.test(key)) ? "***" : value
  }
  return out
}

export function getRedactedHeaderKeys(
  headers: Record<string, string>,
): Array<string> {
  return Object.keys(headers).filter((key) =>
    SENSITIVE_HEADER_PATTERNS.some((re) => re.test(key)),
  )
}

export type OutboundCaptureInput = {
  requestId: string
  httpStatus: number
  upstreamUrl: string
  upstreamMethod: string
  requestHeaders: Record<string, string>
  requestBody: string | null
  requestBodyKind: "json" | "text" | "binary"
  responseStatus: number
  responseHeaders: Record<string, string>
  responseBody: string | null
  responseBodyKind: "json" | "sse" | "text"
}

export type OutboundCaptureRow = OutboundCaptureInput & {
  capturedAtMs: number
}

export interface RequestOutboundStoreApi {
  insert(input: OutboundCaptureInput): void
  getByRequestId(requestId: string): OutboundCaptureRow | null
  cleanupOrphans(): void
}

const INSERT_WARN_THROTTLE_MS = 30_000
let lastWarnAtMs = 0
let suppressedCount = 0

function warnInsertFailure(error: unknown): void {
  const now = Date.now()
  if (now - lastWarnAtMs < INSERT_WARN_THROTTLE_MS) {
    suppressedCount++
    return
  }
  const suppressed = suppressedCount
  suppressedCount = 0
  lastWarnAtMs = now
  const suffix =
    suppressed > 0 ? ` (suppressed ${suppressed} similar errors)` : ""
  consola.warn(`Failed to persist outbound capture${suffix}`, error)
}

export function createRequestOutboundStore(
  db: Database,
): RequestOutboundStoreApi {
  const insertStmt = db.query(`
    INSERT OR REPLACE INTO request_outbound (
      request_id, captured_at_ms, http_status,
      upstream_url, upstream_method,
      request_headers, request_body, request_body_kind,
      response_status, response_headers, response_body, response_body_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `)

  const getByIdStmt = db.query(`
    SELECT * FROM request_outbound WHERE request_id = ? LIMIT 1;
  `)

  const cleanupStmt = db.query(`
    DELETE FROM request_outbound
    WHERE request_id NOT IN (SELECT request_id FROM request_log);
  `)

  return {
    insert(input) {
      try {
        insertStmt.run(
          input.requestId,
          Date.now(),
          input.httpStatus,
          input.upstreamUrl,
          input.upstreamMethod,
          JSON.stringify(redactHeaders(input.requestHeaders)),
          input.requestBody,
          input.requestBodyKind,
          input.responseStatus,
          JSON.stringify(input.responseHeaders),
          input.responseBody,
          input.responseBodyKind,
        )
      } catch (error) {
        warnInsertFailure(error)
      }
    },

    getByRequestId(requestId) {
      try {
        const row = getByIdStmt.get(requestId) as
          | {
              request_id: string
              captured_at_ms: number
              http_status: number
              upstream_url: string
              upstream_method: string
              request_headers: string
              request_body: string | null
              request_body_kind: "json" | "text" | "binary"
              response_status: number
              response_headers: string
              response_body: string | null
              response_body_kind: "json" | "sse" | "text"
            }
          | null
          | undefined

        if (!row) return null

        return {
          requestId: row.request_id,
          capturedAtMs: row.captured_at_ms,
          httpStatus: row.http_status,
          upstreamUrl: row.upstream_url,
          upstreamMethod: row.upstream_method,
          requestHeaders: JSON.parse(row.request_headers) as Record<
            string,
            string
          >,
          requestBody: row.request_body,
          requestBodyKind: row.request_body_kind,
          responseStatus: row.response_status,
          responseHeaders: JSON.parse(row.response_headers) as Record<
            string,
            string
          >,
          responseBody: row.response_body,
          responseBodyKind: row.response_body_kind,
        }
      } catch (error) {
        consola.debug("Failed to fetch outbound capture", error)
        return null
      }
    },

    cleanupOrphans() {
      try {
        cleanupStmt.run()
      } catch (error) {
        consola.debug("Failed to cleanup outbound orphans", error)
      }
    },
  }
}

let sharedStore: RequestOutboundStoreApi | null = null

export function getRequestOutboundStore(): RequestOutboundStoreApi {
  if (sharedStore) return sharedStore
  try {
    sharedStore = createRequestOutboundStore(getAdminDb())
    return sharedStore
  } catch (error) {
    consola.debug("Outbound store unavailable", error)
    return disabledStore
  }
}

const disabledStore: RequestOutboundStoreApi = {
  insert: () => {},
  getByRequestId: () => null,
  cleanupOrphans: () => {},
}
```

- [ ] **Step 4：运行测试，确认通过**

Run: `bun test tests/request-outbound-store.test.ts tests/outbound-redaction.test.ts`
Expected: PASS

- [ ] **Step 5：接入每日孤儿清理**

修改 `src/lib/request-history.ts`：在 `cleanupRetention()` 的末尾追加：

```ts
// Piggy-back outbound orphan cleanup on request-log retention.
try {
  // Lazy import to avoid circular dep at module load.
  const { getRequestOutboundStore } = await import("./request-outbound")
  getRequestOutboundStore().cleanupOrphans()
} catch {
  // best-effort
}
```

如果 `cleanupRetention` 当前是同步的，改为 `cleanupRetention()` 内部直接 `require`-style 调用（本仓库使用 ESM，用动态 `import()` + `.then()` 即可，不必把函数签名变 async）：

```ts
import("./request-outbound")
  .then((m) => m.getRequestOutboundStore().cleanupOrphans())
  .catch(() => {})
```

- [ ] **Step 6：lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: 通过

- [ ] **Step 7：commit**

```bash
git add src/lib/request-outbound.ts src/lib/request-history.ts tests/request-outbound-store.test.ts tests/outbound-redaction.test.ts
git commit -m "feat(lib): add RequestOutboundStore with redaction + orphan cleanup"
```

---

## Task 3 — Developer Mode config + 持久化

**Files:**
- Create: `src/lib/dev-mode.ts`
- Modify: `src/lib/config.ts`
- Create: `tests/dev-mode-config.test.ts`

- [ ] **Step 1：写失败测试**

Create `tests/dev-mode-config.test.ts`：

```ts
import { expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let tmpHome: string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "devmode-test-"))
  process.env.XDG_DATA_HOME = tmpHome
})

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.XDG_DATA_HOME
})

test("defaults to enabled=false, capture4xx=false", async () => {
  const { isDevModeEnabled, isCapture4xxEnabled } = await import("~/lib/dev-mode")
  expect(isDevModeEnabled()).toBe(false)
  expect(isCapture4xxEnabled()).toBe(false)
})
```

(Note: test依赖 `PATHS` 动态读取 `XDG_DATA_HOME`；若当前 `paths.ts` 在 module top-level 计算，改测试为 mock `getConfig()` 直接覆盖。保守方案：mock `getConfig`：)

改为更鲁棒的实现：

```ts
import { expect, test, mock } from "bun:test"

import * as configModule from "~/lib/config"

test("isDevModeEnabled / isCapture4xxEnabled default false", () => {
  const spy = mock(configModule.getConfig)
  spy.mockReturnValue({} as ReturnType<typeof configModule.getConfig>)
  // 直接调用函数断言默认值
})
```

（具体 mock 细节以仓库既有风格为准——如 `tests/config*.test.ts` 里有示例，复用。）

**关键断言**：`isDevModeEnabled()` 在 `config.devMode` 为 undefined 时返回 false；在 `{ enabled: true }` 时返回 true。`isCapture4xxEnabled()` 同理读 `config.devMode?.capture4xx`。

- [ ] **Step 2：运行测试，确认失败**

Run: `bun test tests/dev-mode-config.test.ts`
Expected: FAIL（`~/lib/dev-mode` 不存在）

- [ ] **Step 3：修改 `config.ts` 增加类型**

在 `src/lib/config.ts` 的 `AppConfig` interface 中追加：

```ts
export interface DevModeConfig {
  enabled: boolean
  capture4xx: boolean
}

export interface AppConfig {
  // ... existing fields ...
  devMode?: DevModeConfig
}
```

并在 `defaultConfig` 中追加：

```ts
const defaultConfig: AppConfig = {
  // ... existing fields ...
  devMode: {
    enabled: false,
    capture4xx: false,
  },
}
```

添加 `mergeDefaultDevMode`：

```ts
function mergeDefaultDevMode(config: AppConfig): ConfigMergeResult {
  const current = config.devMode
  if (
    current
    && typeof current.enabled === "boolean"
    && typeof current.capture4xx === "boolean"
  ) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      devMode: {
        enabled: current?.enabled === true,
        capture4xx: current?.capture4xx === true,
      },
    },
    changed: true,
  }
}
```

然后在 `mergeConfigWithDefaults()` 的 `applyConfigMerges` 数组中追加 `mergeDefaultDevMode`。

- [ ] **Step 4：创建 `src/lib/dev-mode.ts`**

```ts
import { getConfig } from "./config"

export function isDevModeEnabled(): boolean {
  return getConfig().devMode?.enabled === true
}

export function isCapture4xxEnabled(): boolean {
  return getConfig().devMode?.capture4xx === true
}
```

- [ ] **Step 5：运行测试，确认通过**

Run: `bun test tests/dev-mode-config.test.ts`
Expected: PASS

- [ ] **Step 6：扩展 admin-api config patch 白名单**

修改 `src/routes/admin-api/route.ts`：

1. `CONFIG_KEYS` 的 Set 加入 `"devMode"`。
2. 新增 handler：

```ts
function parseDevModeConfig(value: unknown): ParseFieldResult<DevModeConfig> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) return { error: "devMode must be an object" }

  const keys = Object.keys(value).filter((k) => k !== "enabled" && k !== "capture4xx")
  if (keys.length > 0) return { error: `devMode.${keys[0]} is not supported` }

  const enabled = value.enabled
  const capture4xx = value.capture4xx
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { error: "devMode.enabled must be a boolean" }
  }
  if (capture4xx !== undefined && typeof capture4xx !== "boolean") {
    return { error: "devMode.capture4xx must be a boolean" }
  }

  return {
    value: {
      enabled: enabled === true,
      capture4xx: capture4xx === true,
    },
  }
}

function applyDevModeConfig(next: AppConfig, value: unknown): string | undefined {
  const parsed = parseDevModeConfig(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next.devMode = { enabled: false, capture4xx: false }
    return undefined
  }
  next.devMode = parsed.value
  return undefined
}
```

3. `CONFIG_PATCH_HANDLERS` 中追加：`devMode: applyDevModeConfig`。
4. 顶部 import 添加 `DevModeConfig`。

- [ ] **Step 7：lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: 通过

- [ ] **Step 8：commit**

```bash
git add src/lib/config.ts src/lib/dev-mode.ts src/routes/admin-api/route.ts tests/dev-mode-config.test.ts
git commit -m "feat(config): add devMode config (enabled + capture4xx) with admin patch support"
```

---

## Task 4 — `copilotFetch` helper：统一上游调用 + 4xx 捕获

**Files:**
- Create: `src/services/copilot/copilot-fetch.ts`
- Create: `tests/copilot-fetch.test.ts`

- [ ] **Step 1：写失败测试**

Create `tests/copilot-fetch.test.ts`：

```ts
import { expect, test, mock, beforeEach } from "bun:test"

import { copilotFetch } from "~/services/copilot/copilot-fetch"
import * as devMode from "~/lib/dev-mode"
import * as store from "~/lib/request-outbound"

type Capture = Parameters<ReturnType<typeof store.getRequestOutboundStore>["insert"]>[0]

let captured: Array<Capture>

function installMockStore(): void {
  captured = []
  mock.module("~/lib/request-outbound", () => ({
    ...store,
    getRequestOutboundStore: () => ({
      insert: (input: Capture) => captured.push(input),
      getByRequestId: () => null,
      cleanupOrphans: () => {},
    }),
  }))
}

beforeEach(() => {
  installMockStore()
  mock.module("~/lib/dev-mode", () => ({
    ...devMode,
    isCapture4xxEnabled: () => true,
  }))
})

function mockFetch(response: Response): void {
  globalThis.fetch = mock(() => Promise.resolve(response)) as typeof fetch
}

test("2xx response is not captured", async () => {
  mockFetch(new Response('{"ok":true}', { status: 200 }))
  const res = await copilotFetch(
    "https://upstream/x",
    { method: "POST", headers: { "x-test": "1" }, body: "{}" },
    { requestId: "r1", callSite: "messages" },
  )
  expect(res.status).toBe(200)
  // give microtask for tee capture path
  await new Promise((r) => setTimeout(r, 10))
  expect(captured.length).toBe(0)
})

test("4xx JSON response is captured with redacted auth", async () => {
  mockFetch(
    new Response('{"error":"bad"}', {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )
  const res = await copilotFetch(
    "https://upstream/x",
    {
      method: "POST",
      headers: { authorization: "Bearer TOKEN", "x-test": "1" },
      body: '{"model":"x"}',
    },
    { requestId: "r2", callSite: "messages" },
  )
  await new Promise((r) => setTimeout(r, 50))
  expect(res.status).toBe(400)
  expect(captured.length).toBe(1)
  expect(captured[0].requestId).toBe("r2")
  expect(captured[0].httpStatus).toBe(400)
  expect(captured[0].requestHeaders["authorization"]).toBe("Bearer TOKEN")
  // store does its own redaction on insert; copilotFetch passes raw headers.
  expect(captured[0].requestBody).toBe('{"model":"x"}')
  expect(captured[0].requestBodyKind).toBe("json")
  expect(captured[0].responseBody).toBe('{"error":"bad"}')
  expect(captured[0].responseBodyKind).toBe("json")
})

test("5xx response is NOT captured", async () => {
  mockFetch(new Response('{"error":"nope"}', { status: 502 }))
  await copilotFetch(
    "https://upstream/x",
    { method: "POST", headers: {}, body: "{}" },
    { requestId: "r3", callSite: "messages" },
  )
  await new Promise((r) => setTimeout(r, 10))
  expect(captured.length).toBe(0)
})

test("capturable:false disables capture for 4xx", async () => {
  mockFetch(new Response("{}", { status: 400 }))
  await copilotFetch(
    "https://upstream/x",
    { method: "POST", headers: {}, body: "{}" },
    { requestId: "r4", callSite: "embeddings", capturable: false },
  )
  await new Promise((r) => setTimeout(r, 10))
  expect(captured.length).toBe(0)
})

test("capture4xx=false disables capture", async () => {
  mock.module("~/lib/dev-mode", () => ({
    ...devMode,
    isCapture4xxEnabled: () => false,
  }))
  mockFetch(new Response("{}", { status: 400 }))
  await copilotFetch(
    "https://upstream/x",
    { method: "POST", headers: {}, body: "{}" },
    { requestId: "r5", callSite: "messages" },
  )
  await new Promise((r) => setTimeout(r, 10))
  expect(captured.length).toBe(0)
})

test("missing requestId disables capture", async () => {
  mockFetch(new Response("{}", { status: 400 }))
  await copilotFetch(
    "https://upstream/x",
    { method: "POST", headers: {}, body: "{}" },
    { callSite: "messages" },
  )
  await new Promise((r) => setTimeout(r, 10))
  expect(captured.length).toBe(0)
})

test("tee() does not corrupt the caller-facing body", async () => {
  mockFetch(
    new Response('{"error":"check-integrity"}', {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )
  const res = await copilotFetch(
    "https://upstream/x",
    { method: "POST", headers: {}, body: "{}" },
    { requestId: "r6", callSite: "messages" },
  )
  expect(await res.text()).toBe('{"error":"check-integrity"}')
})
```

- [ ] **Step 2：运行测试，确认失败**

Run: `bun test tests/copilot-fetch.test.ts`
Expected: FAIL（`copilot-fetch` 不存在）

- [ ] **Step 3：实现 `copilot-fetch.ts`**

Create `src/services/copilot/copilot-fetch.ts`：

```ts
import consola from "consola"

import { isCapture4xxEnabled } from "~/lib/dev-mode"
import { getRequestOutboundStore } from "~/lib/request-outbound"

export type CopilotFetchCtx = {
  requestId?: string
  capturable?: boolean
  callSite: string
}

type RequestSnapshot = {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  bodyKind: "json" | "text" | "binary"
}

function snapshotHeaders(init: RequestInit): Record<string, string> {
  const headers = init.headers
  if (headers instanceof Headers) {
    const out: Record<string, string> = {}
    headers.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return { ...((headers ?? {}) as Record<string, string>) }
}

function snapshotBody(
  init: RequestInit,
): { body: string | null; kind: "json" | "text" | "binary" } {
  const body = init.body
  if (body == null) return { body: null, kind: "text" }
  if (typeof body === "string") {
    try {
      JSON.parse(body)
      return { body, kind: "json" }
    } catch {
      return { body, kind: "text" }
    }
  }
  if (body instanceof Uint8Array) {
    return { body: Buffer.from(body).toString("base64"), kind: "binary" }
  }
  if (body instanceof ArrayBuffer) {
    return {
      body: Buffer.from(new Uint8Array(body)).toString("base64"),
      kind: "binary",
    }
  }
  // ReadableStream / FormData / URLSearchParams: not currently used by Copilot clients.
  return { body: null, kind: "text" }
}

export async function copilotFetch(
  input: string | URL,
  init: RequestInit,
  ctx: CopilotFetchCtx,
): Promise<Response> {
  const urlString = typeof input === "string" ? input : input.toString()

  const requestSnapshot: RequestSnapshot = {
    url: urlString,
    method: (init.method ?? "GET").toUpperCase(),
    headers: snapshotHeaders(init),
    ...snapshotBody(init),
  }

  const response = await fetch(input, init)

  const shouldCapture =
    ctx.requestId != null
    && ctx.capturable !== false
    && isCapture4xxEnabled()
    && response.status >= 400
    && response.status < 500

  if (!shouldCapture) return response

  const contentType = response.headers.get("content-type") ?? ""
  const isSSE = contentType.includes("text/event-stream")
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((v, k) => {
    responseHeaders[k] = v
  })

  if (!response.body) {
    persist(requestSnapshot, response, "", isSSE ? "sse" : "json", responseHeaders, ctx)
    return response
  }

  const [forClient, forCapture] = response.body.tee()

  void (async () => {
    const chunks: Array<Uint8Array> = []
    const reader = forCapture.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
      const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      const text = buffer.toString("utf8")
      const kind: "json" | "sse" | "text" =
        isSSE ? "sse"
        : contentType.includes("application/json") ? "json"
        : "text"
      persist(requestSnapshot, response, text, kind, responseHeaders, ctx)
    } catch (error) {
      consola.debug("copilotFetch capture stream failed", error)
    }
  })()

  return new Response(forClient, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function persist(
  req: RequestSnapshot,
  res: Response,
  responseBody: string,
  responseBodyKind: "json" | "sse" | "text",
  responseHeaders: Record<string, string>,
  ctx: CopilotFetchCtx,
): void {
  if (!ctx.requestId) return
  try {
    getRequestOutboundStore().insert({
      requestId: ctx.requestId,
      httpStatus: res.status,
      upstreamUrl: req.url,
      upstreamMethod: req.method,
      requestHeaders: req.headers,
      requestBody: req.body,
      requestBodyKind: req.bodyKind,
      responseStatus: res.status,
      responseHeaders,
      responseBody,
      responseBodyKind,
    })
  } catch (error) {
    consola.debug("copilotFetch persist failed", error)
  }
}
```

- [ ] **Step 4：运行测试，确认通过**

Run: `bun test tests/copilot-fetch.test.ts`
Expected: PASS（全部 7 条）

- [ ] **Step 5：lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: 通过

- [ ] **Step 6：commit**

```bash
git add src/services/copilot/copilot-fetch.ts tests/copilot-fetch.test.ts
git commit -m "feat(copilot): add copilotFetch helper with conditional 4xx capture"
```

---

## Task 5 — 迁移 5 个 Copilot service 客户端到 `copilotFetch`

**Files:**
- Modify: `src/services/copilot/create-messages.ts`
- Modify: `src/services/copilot/create-chat-completions.ts`
- Modify: `src/services/copilot/create-responses.ts`
- Modify: `src/services/copilot/create-embeddings.ts`
- Modify: `src/services/copilot/get-models.ts`
- Modify: `src/routes/messages/handler.ts` 与其他调用 service 的 handler（传 requestId）

每个客户端迁移遵循同一模式；单独 commit 便于 bisect。

### 5.1 `create-messages.ts`

- [ ] **Step 1：增加可选 `requestId` 参数并替换 fetch**

编辑 `src/services/copilot/create-messages.ts`：

在 `createMessages` 的 `options` 中加入 `requestId?: string`。替换 `fetch` 调用：

```ts
// 顶部 imports
import { copilotFetch } from "./copilot-fetch"

// ...原 fetch 位置：
const response = await copilotFetch(
  `${copilotBaseUrl(ctx)}/v1/messages`,
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  },
  {
    requestId: options?.requestId,
    callSite: "messages",
  },
)
```

- [ ] **Step 2：在 handler 层传入 requestId**

修改 `src/routes/messages/handler.ts`：找到调 `createMessages(...)` 的位置，在 `options` 对象中追加 `requestId: requestLog.requestId`（或等价变量——handler 已经持有 request_id 以便写 `request_log`，直接复用）。

- [ ] **Step 3：回归已有 message 测试**

Run: `bun test tests/messages-handler.test.ts tests/create-messages.test.ts`
Expected: 全部通过（逻辑等价）

- [ ] **Step 4：commit**

```bash
git add src/services/copilot/create-messages.ts src/routes/messages/handler.ts
git commit -m "refactor(copilot): route createMessages through copilotFetch helper"
```

### 5.2 `create-chat-completions.ts`

- [ ] **Step 1：增参 + 替换**

同 5.1 模式；`callSite: "chat-completions"`；handler 调用点传入 `requestId`。

- [ ] **Step 2：回归 `tests/chat-completions*.test.ts`（如存在）**

Run: `bun test tests/`
Expected: 通过

- [ ] **Step 3：commit**

```bash
git commit -m "refactor(copilot): route createChatCompletions through copilotFetch"
```

### 5.3 `create-responses.ts`

- [ ] 同 5.1 模式；`callSite: "responses"`；commit message: `refactor(copilot): route createResponses through copilotFetch`

### 5.4 `create-embeddings.ts`

- [ ] 同 5.1 模式；`callSite: "embeddings"`，**且** 传 `capturable: false`；commit message: `refactor(copilot): route createEmbeddings through copilotFetch (capturable=false)`

### 5.5 `get-models.ts`

- [ ] 同 5.1 模式；`callSite: "models"`，`capturable: false`；commit message: `refactor(copilot): route getModels through copilotFetch (capturable=false)`

### 5.6 集成断言测试

- [ ] **Step 1：扩展 messages handler 回归测试**

在 `tests/messages-handler.test.ts` 追加一个 case（或新建 `tests/messages-outbound-capture.test.ts`）：mock 上游 400 响应 + `capture4xx=true`，断言 `request_outbound` 表中存在对应 `request_id` 的行；然后 2xx 响应断言无行。

- [ ] **Step 2：跑 typecheck + lint**

```bash
bun run typecheck && bun run lint
```

- [ ] **Step 3：commit 集成测试**

```bash
git add tests/messages-outbound-capture.test.ts
git commit -m "test(messages): cover outbound capture on 4xx"
```

---

## Task 6 — `/api/admin/dev-mode` 端点

**Files:**
- Create: `src/routes/admin-api/replay.ts`（骨架）
- Modify: `src/routes/admin-api/route.ts`（挂载）
- Test: 扩展 `tests/admin-api-*`（或新建 `tests/admin-api-dev-mode.test.ts`）

- [ ] **Step 1：写失败测试**

Create `tests/admin-api-dev-mode.test.ts`：

```ts
import { expect, test } from "bun:test"

import { adminApiRoutes } from "~/routes/admin-api/route"

async function request(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  return adminApiRoutes.request(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
}

test("GET /dev-mode returns defaults", async () => {
  const res = await request("GET", "/dev-mode")
  expect(res.status).toBe(200)
  const json = (await res.json()) as { enabled: boolean; capture4xx: boolean }
  expect(json.enabled).toBe(false)
  expect(json.capture4xx).toBe(false)
})

test("POST /dev-mode updates state", async () => {
  const res = await request("POST", "/dev-mode", { enabled: true })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { enabled: boolean; capture4xx: boolean }
  expect(json.enabled).toBe(true)
  expect(json.capture4xx).toBe(false)
})
```

（此测试依赖临时 config 环境；若已有其他 admin-api 测试夹具，复用。）

- [ ] **Step 2：运行，确认失败**

Run: `bun test tests/admin-api-dev-mode.test.ts`
Expected: FAIL（路由不存在）

- [ ] **Step 3：实现端点**

Create `src/routes/admin-api/replay.ts`：

```ts
import { Hono, type Context } from "hono"

import type { AppConfig, DevModeConfig } from "~/lib/config"

import { getConfig, mergeConfigWithDefaults } from "~/lib/config"
import { isDevModeEnabled } from "~/lib/dev-mode"
import { writeConfigFile } from "./config-writer" // reuse or inline

export const replayRoutes = new Hono()

replayRoutes.get("/dev-mode", (c) => {
  const dev = getConfig().devMode ?? { enabled: false, capture4xx: false }
  return c.json({ enabled: dev.enabled === true, capture4xx: dev.capture4xx === true })
})

replayRoutes.post("/dev-mode", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json(
      { error: { message: "Body must be valid JSON", type: "bad_request" } },
      400,
    )
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return c.json(
      { error: { message: "Body must be an object", type: "bad_request" } },
      400,
    )
  }

  const patch = payload as Partial<DevModeConfig>
  const current = getConfig().devMode ?? { enabled: false, capture4xx: false }
  const next: DevModeConfig = {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : current.enabled === true,
    capture4xx:
      typeof patch.capture4xx === "boolean"
        ? patch.capture4xx
        : current.capture4xx === true,
  }

  const config = { ...getConfig(), devMode: next } satisfies AppConfig
  await writeConfigFile(config)
  mergeConfigWithDefaults()

  return c.json(next)
})

export function requireDevMode(c: Context): Response | null {
  if (!isDevModeEnabled()) {
    return c.json(
      {
        error: {
          message: "Developer mode disabled",
          type: "forbidden",
        },
      },
      403,
    )
  }
  return null
}
```

**注意**：`writeConfigFile` 当前存在于 `route.ts` 本地；把它提取为 `src/routes/admin-api/config-writer.ts` 暴露 `export async function writeConfigFile(config: AppConfig): Promise<void>`，然后 `route.ts` 和 `replay.ts` 共用。

- [ ] **Step 4：在 `route.ts` 挂载**

```ts
// src/routes/admin-api/route.ts 末尾
import { replayRoutes } from "./replay"
adminApiRoutes.route("/", replayRoutes)
```

- [ ] **Step 5：运行测试，确认通过**

Run: `bun test tests/admin-api-dev-mode.test.ts`
Expected: PASS

- [ ] **Step 6：commit**

```bash
git add src/routes/admin-api/replay.ts src/routes/admin-api/config-writer.ts src/routes/admin-api/route.ts tests/admin-api-dev-mode.test.ts
git commit -m "feat(admin-api): add GET/POST /dev-mode endpoints"
```

---

## Task 7 — `/api/admin/requests/:id/outbound` 端点

**Files:**
- Modify: `src/routes/admin-api/replay.ts`
- Test: `tests/admin-api-outbound.test.ts`

- [ ] **Step 1：写失败测试**

Create `tests/admin-api-outbound.test.ts`：

- 403 when devMode disabled
- 404 when no blob
- 200 with redacted headers + `redacted_header_keys` 数组

（使用 in-memory admin db + mock requestOutboundStore 注入样本数据）

- [ ] **Step 2：运行，确认失败**

Run: `bun test tests/admin-api-outbound.test.ts`
Expected: FAIL

- [ ] **Step 3：实现端点**

在 `src/routes/admin-api/replay.ts` 追加：

```ts
import { getRequestHistoryStore } from "~/lib/request-history"
import { getRedactedHeaderKeys, getRequestOutboundStore } from "~/lib/request-outbound"

replayRoutes.get("/requests/:requestId/outbound", (c) => {
  const gate = requireDevMode(c)
  if (gate) return gate

  const requestId = c.req.param("requestId")
  const blob = getRequestOutboundStore().getByRequestId(requestId)
  if (!blob) {
    return c.json(
      { error: { message: "No outbound captured for this request", type: "not_found" } },
      404,
    )
  }

  const logRow = getRequestHistoryStore().getByRequestId(requestId)

  return c.json({
    request_id: blob.requestId,
    captured_at_ms: blob.capturedAtMs,
    http_status: blob.httpStatus,
    upstream_url: blob.upstreamUrl,
    upstream_method: blob.upstreamMethod,
    request_headers: blob.requestHeaders,
    request_body: blob.requestBody,
    request_body_kind: blob.requestBodyKind,
    response_status: blob.responseStatus,
    response_headers: blob.responseHeaders,
    response_body: blob.responseBody,
    response_body_kind: blob.responseBodyKind,
    redacted_header_keys: getRedactedHeaderKeys(blob.requestHeaders),
    original: logRow
      ? {
          path: logRow.path,
          upstream_endpoint: logRow.upstream_endpoint,
          upstream_model: logRow.upstream_model,
          account_id: logRow.account_id,
          client_model: logRow.client_model,
        }
      : null,
  })
})
```

- [ ] **Step 4：运行测试，确认通过**

Run: `bun test tests/admin-api-outbound.test.ts`
Expected: PASS

- [ ] **Step 5：commit**

```bash
git add src/routes/admin-api/replay.ts tests/admin-api-outbound.test.ts
git commit -m "feat(admin-api): add GET /requests/:id/outbound"
```

---

## Task 8 — `/api/admin/requests/:id/replay`（collect 模式）

**Files:**
- Modify: `src/routes/admin-api/replay.ts`
- Test: `tests/replay-handler.test.ts`

- [ ] **Step 1：写失败测试**

Create `tests/replay-handler.test.ts`，覆盖：

1. `devMode.enabled=false` → 403
2. blob 缺失 → 404
3. `accountId` 不存在 → 400
4. `overrides.body` 非法 JSON（kind=json）→ 400
5. 成功 collect：mock upstream 返回 400 JSON → 响应含 `raw.body`、`raw.kind === "json"`、`durationMs`；且验证发给 mock fetch 的 headers 中 **不含** `"***"` 值（即脱敏的 Authorization 被 injectAuthHeaders 重新注入为真实 token）。
6. Spy 断言：重放路径不调用 `requestHistoryStore.insert`。

（mock accountsManager：提供一个固定 `{ copilotToken: "replay-token", ... }` 的账号。）

- [ ] **Step 2：运行，确认失败**

Run: `bun test tests/replay-handler.test.ts`
Expected: FAIL

- [ ] **Step 3：实现 collect 端点**

在 `src/routes/admin-api/replay.ts` 追加：

```ts
import { accountsManager } from "~/lib/accounts-manager"
import { copilotFetch } from "~/services/copilot/copilot-fetch"
import { buildCopilotAuthHeaders } from "~/lib/api-config" // 如现状是 `copilotHeaders`，复用它
import { translateForReplay } from "./replay-translation"  // new module, see below

type ReplayRequestBody = {
  accountId: string
  overrides?: {
    body?: string
    headers?: Record<string, string>
  }
  mode?: "collect" | "live"
}

replayRoutes.post("/requests/:requestId/replay", async (c) => {
  const gate = requireDevMode(c)
  if (gate) return gate

  const requestId = c.req.param("requestId")
  const blob = getRequestOutboundStore().getByRequestId(requestId)
  if (!blob) {
    return c.json(
      { error: { message: "No outbound captured for this request", type: "not_found" } },
      404,
    )
  }
  const logRow = getRequestHistoryStore().getByRequestId(requestId)
  if (!logRow) {
    return c.json(
      { error: { message: "Original request log missing", type: "not_found" } },
      404,
    )
  }

  let body: ReplayRequestBody
  try {
    body = (await c.req.json()) as ReplayRequestBody
  } catch {
    return c.json(
      { error: { message: "Body must be valid JSON", type: "bad_request" } },
      400,
    )
  }

  const account = accountsManager.getAccountById(body.accountId)
  if (!account || account.disabled || account.failed) {
    return c.json(
      { error: { message: "Account not available", type: "bad_request" } },
      400,
    )
  }

  const bodyText =
    body.overrides?.body !== undefined ? body.overrides.body : blob.requestBody

  if (blob.requestBodyKind === "json" && bodyText) {
    try {
      JSON.parse(bodyText)
    } catch (err) {
      return c.json(
        {
          error: {
            message: `Invalid JSON body override: ${(err as Error).message}`,
            type: "bad_request",
          },
        },
        400,
      )
    }
  }

  const mergedHeaders: Record<string, string> = {
    ...blob.requestHeaders,
    ...(body.overrides?.headers ?? {}),
  }

  // Remove redacted placeholders — they will be replaced by real auth headers.
  for (const key of Object.keys(mergedHeaders)) {
    if (mergedHeaders[key] === "***") delete mergedHeaders[key]
  }

  // Inject fresh auth headers from the selected account.
  // Authorization wins — merged last so user-provided headers can never override.
  const authHeaders = buildCopilotAuthHeaders(account)
  const finalHeaders = { ...mergedHeaders, ...authHeaders }

  const startMs = Date.now()
  const upstreamRes = await copilotFetch(
    blob.upstreamUrl,
    {
      method: blob.upstreamMethod,
      headers: finalHeaders,
      body: bodyText,
    },
    { callSite: "replay", capturable: false },
  )

  const mode = body.mode === "live" ? "live" : "collect"
  if (mode === "collect") {
    return collectAndRespond(c, upstreamRes, logRow, startMs)
  }
  return streamAndRespond(c, upstreamRes, logRow, startMs)
})

async function collectAndRespond(
  c: Context,
  upstreamRes: Response,
  logRow: ReturnType<ReturnType<typeof getRequestHistoryStore>["getByRequestId"]>,
  startMs: number,
): Promise<Response> {
  const durationMs = Date.now() - startMs
  const ct = upstreamRes.headers.get("content-type") ?? ""
  const rawText = await upstreamRes.text()
  const rawKind: "json" | "sse" | "text" =
    ct.includes("text/event-stream") ? "sse"
    : ct.includes("application/json") ? "json"
    : "text"

  let translated: unknown = null
  if (logRow?.path === "/v1/messages") {
    try {
      translated = translateForReplay({
        upstreamEndpoint: logRow.upstream_endpoint ?? "",
        rawText,
        rawKind,
      })
    } catch (err) {
      translated = { error: (err as Error).message }
    }
  }

  const responseHeaders: Record<string, string> = {}
  upstreamRes.headers.forEach((v, k) => {
    responseHeaders[k] = v
  })

  return c.json({
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: responseHeaders,
    raw: { body: rawText, kind: rawKind },
    translated,
    durationMs,
    replayedAt: Date.now(),
  })
}

async function streamAndRespond(
  _c: Context,
  _upstreamRes: Response,
  _logRow: unknown,
  _startMs: number,
): Promise<Response> {
  // Implemented in Task 9.
  throw new Error("live mode not yet implemented")
}
```

**`buildCopilotAuthHeaders` 说明**：如果 `api-config.ts` 没有恰好对应的 exported 函数，实现一个薄 shim：

```ts
// src/routes/admin-api/replay-auth.ts
import type { AccountContext } from "~/lib/types/account"

import { copilotHeaders } from "~/lib/api-config"

export function buildCopilotAuthHeaders(account: AccountContext): Record<string, string> {
  // Reuse the canonical header constructor; callers can strip non-auth fields if needed.
  return copilotHeaders(account)
}
```

- [ ] **Step 4：实现 `replay-translation.ts`**

Create `src/routes/admin-api/replay-translation.ts`：

```ts
import { translateToAnthropic } from "~/routes/messages/non-stream-translation"
import { translateStreamToAnthropic } from "~/routes/messages/stream-translation"
import { translateResponsesToAnthropic } from "~/routes/messages/responses-translation"

export type TranslateForReplayInput = {
  upstreamEndpoint: string
  rawText: string
  rawKind: "json" | "sse" | "text"
}

export function translateForReplay(input: TranslateForReplayInput): unknown {
  const { upstreamEndpoint, rawText, rawKind } = input

  if (upstreamEndpoint.endsWith("/chat/completions")) {
    if (rawKind === "sse") {
      return translateStreamToAnthropic(rawText)
    }
    if (rawKind === "json") {
      return translateToAnthropic(JSON.parse(rawText))
    }
    return { error: "Unable to translate non-json/sse chat completion" }
  }

  if (upstreamEndpoint.endsWith("/responses")) {
    return translateResponsesToAnthropic(rawText, rawKind)
  }

  if (upstreamEndpoint.endsWith("/v1/messages")) {
    return rawKind === "json" ? JSON.parse(rawText) : rawText
  }

  return null
}
```

**注意**：上面 `translateStreamToAnthropic` / `translateResponsesToAnthropic` 等函数名可能与仓库实际函数名不同。实施时 grep 一下 `src/routes/messages/*translation*.ts` 的 exports，使用真实名字；如果没有能直接接收 raw text 的函数，就在 `replay-translation.ts` 里做一层解析适配。

- [ ] **Step 5：运行测试，确认通过**

Run: `bun test tests/replay-handler.test.ts`
Expected: PASS

- [ ] **Step 6：commit**

```bash
git add src/routes/admin-api/replay.ts src/routes/admin-api/replay-auth.ts src/routes/admin-api/replay-translation.ts tests/replay-handler.test.ts
git commit -m "feat(admin-api): add POST /requests/:id/replay (collect mode)"
```

---

## Task 9 — Replay 端点 live SSE 模式

**Files:**
- Modify: `src/routes/admin-api/replay.ts`
- Test: `tests/replay-stream.test.ts`

- [ ] **Step 1：写失败测试**

Create `tests/replay-stream.test.ts`：
- mock upstream 返回 SSE `data: A\n\ndata: B\n\n`
- POST `/requests/:id/replay` with `mode: "live"`
- 断言响应 Content-Type 是 `text/event-stream`
- 断言事件流包含顺序：`upstream-start` → 至少 2 次 `upstream-chunk` → `upstream-done` → `translated`

- [ ] **Step 2：运行，确认失败**

Run: `bun test tests/replay-stream.test.ts`
Expected: FAIL

- [ ] **Step 3：实现 `streamAndRespond`**

替换 Task 8 中的 stub：

```ts
import { streamSSE } from "hono/streaming"

async function streamAndRespond(
  c: Context,
  upstreamRes: Response,
  logRow: ReturnType<ReturnType<typeof getRequestHistoryStore>["getByRequestId"]>,
  startMs: number,
): Promise<Response> {
  return streamSSE(c, async (sse) => {
    const responseHeaders: Record<string, string> = {}
    upstreamRes.headers.forEach((v, k) => {
      responseHeaders[k] = v
    })

    await sse.writeSSE({
      event: "upstream-start",
      data: JSON.stringify({
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: responseHeaders,
      }),
    })

    const rawChunks: Array<string> = []
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        rawChunks.push(chunk)
        await sse.writeSSE({
          event: "upstream-chunk",
          data: JSON.stringify({ raw: chunk }),
        })
      }
    }

    await sse.writeSSE({
      event: "upstream-done",
      data: JSON.stringify({ durationMs: Date.now() - startMs }),
    })

    const ct = upstreamRes.headers.get("content-type") ?? ""
    const rawText = rawChunks.join("")
    const rawKind: "json" | "sse" | "text" =
      ct.includes("text/event-stream") ? "sse"
      : ct.includes("application/json") ? "json"
      : "text"

    if (logRow?.path === "/v1/messages") {
      try {
        const translated = translateForReplay({
          upstreamEndpoint: logRow.upstream_endpoint ?? "",
          rawText,
          rawKind,
        })
        await sse.writeSSE({
          event: "translated",
          data: JSON.stringify(translated),
        })
      } catch (err) {
        await sse.writeSSE({
          event: "translated",
          data: JSON.stringify({ error: (err as Error).message }),
        })
      }
    }
  })
}
```

- [ ] **Step 4：运行测试，确认通过**

Run: `bun test tests/replay-stream.test.ts`
Expected: PASS

- [ ] **Step 5：commit**

```bash
git add src/routes/admin-api/replay.ts tests/replay-stream.test.ts
git commit -m "feat(admin-api): add live SSE mode to replay endpoint"
```

---

## Task 10 — Admin-UI API client + SSE util

**Files:**
- Modify: `admin-ui/src/lib/admin-api.ts`
- Create: `admin-ui/src/lib/sse.ts`

- [ ] **Step 1：添加 SSE util**

Create `admin-ui/src/lib/sse.ts`：

```ts
export type SSEEvent = {
  event?: string
  data: string
}

export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""

  while (!signal?.aborted) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf("\n\n")
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      let event: string | undefined
      const dataLines: Array<string> = []
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length > 0) onEvent({ event, data: dataLines.join("\n") })
      boundary = buffer.indexOf("\n\n")
    }
  }
}
```

- [ ] **Step 2：扩展 admin-api client**

在 `admin-ui/src/lib/admin-api.ts` 追加：

```ts
export type DevModeState = { enabled: boolean; capture4xx: boolean }

export async function getDevMode(): Promise<DevModeState> {
  return request("/api/admin/dev-mode")
}

export async function setDevMode(patch: Partial<DevModeState>): Promise<DevModeState> {
  return request("/api/admin/dev-mode", {
    method: "POST",
    body: JSON.stringify(patch),
  })
}

export type OutboundBlob = {
  request_id: string
  captured_at_ms: number
  http_status: number
  upstream_url: string
  upstream_method: string
  request_headers: Record<string, string>
  request_body: string | null
  request_body_kind: "json" | "text" | "binary"
  response_status: number
  response_headers: Record<string, string>
  response_body: string | null
  response_body_kind: "json" | "sse" | "text"
  redacted_header_keys: Array<string>
  original: {
    path: string
    upstream_endpoint: string | null
    upstream_model: string | null
    account_id: string | null
    client_model: string | null
  } | null
}

export async function getRequestOutbound(requestId: string): Promise<OutboundBlob> {
  return request(`/api/admin/requests/${encodeURIComponent(requestId)}/outbound`)
}

export type ReplayRequest = {
  accountId: string
  overrides?: {
    body?: string
    headers?: Record<string, string>
  }
  mode: "collect" | "live"
}

export type ReplayCollectResult = {
  status: number
  statusText: string
  headers: Record<string, string>
  raw: { body: string; kind: "json" | "sse" | "text" }
  translated: unknown
  durationMs: number
  replayedAt: number
}

export async function replayCollect(
  requestId: string,
  req: Omit<ReplayRequest, "mode">,
): Promise<ReplayCollectResult> {
  return request(`/api/admin/requests/${encodeURIComponent(requestId)}/replay`, {
    method: "POST",
    body: JSON.stringify({ ...req, mode: "collect" }),
  })
}

export async function replayLive(
  requestId: string,
  req: Omit<ReplayRequest, "mode">,
  onEvent: (event: import("./sse").SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/admin/requests/${encodeURIComponent(requestId)}/replay`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(getAdminToken() ? { "x-admin-token": getAdminToken()! } : {}),
      },
      body: JSON.stringify({ ...req, mode: "live" }),
      signal,
    },
  )
  if (!res.ok || !res.body) {
    const text = await res.text()
    throw new AdminApiError(`Replay failed: ${text}`, res.status)
  }
  const { parseSSEStream } = await import("./sse")
  await parseSSEStream(res.body.getReader(), onEvent, signal)
}
```

假设 `request(...)`、`AdminApiError`、`getAdminToken()` 已在 admin-api.ts 中存在（从现有文件复用）。

- [ ] **Step 3：typecheck**

Run: `cd admin-ui && bun run typecheck && cd ..`
Expected: 通过

- [ ] **Step 4：commit**

```bash
git add admin-ui/src/lib/admin-api.ts admin-ui/src/lib/sse.ts
git commit -m "feat(admin-ui): add dev-mode/outbound/replay API clients and SSE util"
```

---

## Task 11 — Settings 页 Developer Mode 开关

**Files:**
- Modify: `admin-ui/src/pages/settings-page.tsx`
- Modify: `admin-ui/src/locales/en.json` / `zh.json`

- [ ] **Step 1：添加 i18n 文案**

`en.json`：

```json
"settingsPage": {
  "devMode": {
    "title": "Developer Mode",
    "description": "Enable in-app request replay and 4xx outbound capture for debugging.",
    "enable": "Enable Developer Mode",
    "enableHint": "Required to access the Replay page. Backend enforces this flag — disabling denies all replay endpoints.",
    "capture": "Capture 4xx upstream payloads",
    "captureHint": "Persists the full outbound body + redacted headers to admin.sqlite whenever an upstream call returns 4xx. May contain prompt content; cleaned up with request history (35 days).",
    "captureDisabled": "Enable Developer Mode first to unlock capture."
  }
}
```

`zh.json`：对应中文翻译。

- [ ] **Step 2：实现 UI**

在 `settings-page.tsx` 中新增一张 `Card`，内含两个 `Switch`（`enabled` / `capture4xx`），capture 控件 `disabled={!enabled}`。加载使用 `getDevMode()`；点击调 `setDevMode({...})` 并在成功后 toast。

（具体 UI 片段遵循现有 settings-page 的 pattern，例如其它 config 开关的布局方式。）

- [ ] **Step 3：手测 dev server**

Run (background): `bun run dev:admin`
打开 `http://localhost:5173/settings`，勾选 Enable → 再勾选 Capture → 刷新页面确认两者状态持久化。

- [ ] **Step 4：commit**

```bash
git add admin-ui/src/pages/settings-page.tsx admin-ui/src/locales/en.json admin-ui/src/locales/zh.json
git commit -m "feat(admin-ui): add Developer Mode toggles to settings page"
```

---

## Task 12 — 请求详情页增加 Replay 入口按钮

**Files:**
- Modify: `admin-ui/src/pages/request-detail-page.tsx`
- Modify: `src/routes/admin-api/route.ts`（`/requests/:id` 响应追加 `has_outbound`）
- Modify: `admin-ui/src/locales/{en,zh}.json`

- [ ] **Step 1：后端：在 `/requests/:requestId` 响应中追加 `has_outbound`**

修改 `src/routes/admin-api/route.ts` 中的 `adminApiRoutes.get("/requests/:requestId", ...)`：

```ts
adminApiRoutes.get("/requests/:requestId", (c) => {
  const requestId = c.req.param("requestId")
  const store = getRequestHistoryStore()
  const item = store.getByRequestId(requestId)
  const hasOutbound =
    item !== null
    && getRequestOutboundStore().getByRequestId(requestId) !== null
  return c.json({ item, has_outbound: hasOutbound })
})
```

顶部 import `getRequestOutboundStore`.

- [ ] **Step 2：前端：加 Replay 按钮**

在 `request-detail-page.tsx` 的工具栏（Refresh 按钮附近）加：

```tsx
{devMode.enabled && (
  <Button
    variant="default"
    size="sm"
    disabled={!hasOutbound}
    asChild={hasOutbound}
  >
    {hasOutbound ? (
      <Link to={`/requests/${item.request_id}/replay`}>
        <PlayIcon className="size-4" />
        {t("requestDetailPage.replay.button")}
      </Link>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <PlayIcon className="size-4" />
            {t("requestDetailPage.replay.button")}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("requestDetailPage.replay.noBlob")}</TooltipContent>
      </Tooltip>
    )}
  </Button>
)}
```

`devMode` 状态通过 `getDevMode()` on mount 获取；`hasOutbound` 从 `/requests/:id` 的 `has_outbound` 字段读。

- [ ] **Step 3：i18n**

`en.json`：

```json
"requestDetailPage": {
  "replay": {
    "button": "Replay",
    "noBlob": "This request did not trigger 4xx capture or predates Developer Mode."
  }
}
```

- [ ] **Step 4：typecheck**

```bash
bun run typecheck && (cd admin-ui && bun run typecheck)
```

- [ ] **Step 5：commit**

```bash
git add admin-ui/src/pages/request-detail-page.tsx src/routes/admin-api/route.ts admin-ui/src/locales/en.json admin-ui/src/locales/zh.json
git commit -m "feat(admin-ui): add Replay entry button on request detail page"
```

---

## Task 13 — Replay 页容器 + Context 卡片

**Files:**
- Create: `admin-ui/src/pages/request-replay-page.tsx`
- Create: `admin-ui/src/components/replay/replay-context-card.tsx`
- Modify: `admin-ui/src/App.tsx`

- [ ] **Step 1：注册路由**

在 `admin-ui/src/App.tsx` 中加：

```tsx
import { RequestReplayPage } from "@/pages/request-replay-page"
// ...
<Route path="/requests/:requestId/replay" element={<RequestReplayPage />} />
```

- [ ] **Step 2：创建 Context 卡片**

`replay-context-card.tsx`：展示只读的 `request_id` / `path` / `upstream_endpoint` / `upstream_model` / `client_model` / `response_status` 原始值。

- [ ] **Step 3：创建 Replay 页骨架**

`request-replay-page.tsx`：

```tsx
export function RequestReplayPage(): React.JSX.Element {
  const { requestId = "" } = useParams()
  const [state, setState] = useState<ReplayState>({ phase: "loading-blob" })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [blob, devMode] = await Promise.all([
          getRequestOutbound(requestId),
          getDevMode(),
        ])
        if (cancelled) return
        if (!devMode.enabled) {
          setState({ phase: "error", message: "Developer Mode disabled" })
          return
        }
        setState({
          phase: "ready",
          form: buildInitialForm(blob),
          blob,
        })
      } catch (err) {
        if (cancelled) return
        setState({
          phase: err instanceof AdminApiError && err.status === 404 ? "no-blob" : "error",
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => { cancelled = true }
  }, [requestId])

  // Render skeleton + ReplayContextCard + placeholders for Headers/Body/Response (Task 14/15/16)
  return <div>...</div>
}

function buildInitialForm(blob: OutboundBlob): ReplayForm {
  return {
    accountId: blob.original?.account_id ?? "",
    headers: Object.entries(blob.request_headers).map(([key, value]) => ({
      key,
      value,
      editable: !blob.redacted_header_keys.includes(key),
    })),
    bodyText: blob.request_body ?? "",
    mode: "collect",
  }
}
```

- [ ] **Step 4：typecheck + 启动 dev 手测**

```bash
cd admin-ui && bun run typecheck
```

确保路由解析正确：访问 `/requests/<id>/replay` 不 404。

- [ ] **Step 5：commit**

```bash
git add admin-ui/src/App.tsx admin-ui/src/pages/request-replay-page.tsx admin-ui/src/components/replay/replay-context-card.tsx
git commit -m "feat(admin-ui): scaffold RequestReplayPage with Context card"
```

---

## Task 14 — Headers 编辑器 + Account 选择

**Files:**
- Create: `admin-ui/src/components/replay/replay-headers-editor.tsx`
- Create: `admin-ui/src/components/replay/replay-account-select.tsx`
- Modify: `admin-ui/src/pages/request-replay-page.tsx`

- [ ] **Step 1：Account 下拉**

`replay-account-select.tsx`：
- 从 `getAdminAccounts()` 列出
- 过滤 `runtime.enabled !== false && !runtime.failed`
- 原账号（blob.original.account_id）置顶并显示 "original" badge
- 绑定到 form.accountId

- [ ] **Step 2：Headers 编辑器**

`replay-headers-editor.tsx`：
- 渲染 `form.headers` 数组
- `editable=false` 行：value 强制显示 `***`、禁 delete、禁 edit
- 可编辑行：可改 key/value/删除
- "+ Add header" 按钮；key 合法性 `/^[A-Za-z0-9-]+$/`；新增 key 禁止命中正则：`/^authorization$/i` / `/^x-github-token$/i` / `/-token$/i` / `/-secret$/i` / `/^cookie$/i` / `/^x-api-key$/i`（与后端同一份）→ 拒绝并 toast error

- [ ] **Step 3：组件单测**

Create `admin-ui/tests/replay-headers-editor.test.tsx`（若已有 testing-library 基础设施）；否则延后至手测。

Run: `cd admin-ui && bun test`

- [ ] **Step 4：接入页面**

在 `request-replay-page.tsx` 的 `phase: "ready"` 分支中渲染 `<ReplayAccountSelect />` + `<ReplayHeadersEditor />`。

- [ ] **Step 5：commit**

```bash
git add admin-ui/src/components/replay/replay-account-select.tsx admin-ui/src/components/replay/replay-headers-editor.tsx admin-ui/src/pages/request-replay-page.tsx admin-ui/tests/replay-headers-editor.test.tsx
git commit -m "feat(admin-ui): add account select and headers editor for replay"
```

---

## Task 15 — Body 编辑器

**Files:**
- Create: `admin-ui/src/components/replay/replay-body-editor.tsx`
- Modify: `admin-ui/src/pages/request-replay-page.tsx`

- [ ] **Step 1：选型**

使用 `codemirror` + `@codemirror/lang-json`（已有则复用；否则 `bun add @codemirror/state @codemirror/view @codemirror/lang-json @uiw/react-codemirror -w admin-ui`）。

- [ ] **Step 2：实现三种 kind**

`replay-body-editor.tsx`：
- `kind=json`：CodeMirror + JSON 语法；工具栏 Format / Reset to captured
- `kind=text`：简单 `<Textarea />`
- `kind=binary`：只读展示 base64，显示 disclaimer "binary body — content read-only"

- [ ] **Step 3：校验**

export `validateReplayBody(bodyText: string, kind): { ok: true } | { ok: false; message: string }`，kind=json 时 `JSON.parse` 校验。

- [ ] **Step 4：接入页面**

在 Replay 页左侧渲染。Send 按钮 disabled 条件：`!validateReplayBody(...).ok`。

- [ ] **Step 5：commit**

```bash
git add admin-ui/src/components/replay/replay-body-editor.tsx admin-ui/src/pages/request-replay-page.tsx admin-ui/package.json admin-ui/bun.lockb
git commit -m "feat(admin-ui): add JSON/text/binary body editor for replay"
```

---

## Task 16 — Response 面板 + Collect + Live 发送

**Files:**
- Create: `admin-ui/src/components/replay/replay-response-panel.tsx`
- Modify: `admin-ui/src/pages/request-replay-page.tsx`

- [ ] **Step 1：Response Panel**

`replay-response-panel.tsx`：
- Tabs：Raw / Translated / Headers
- Translated：当 `blob.original.path !== "/v1/messages"` 时灰掉 + tooltip
- Raw：kind=json 用 `JsonViewer`；kind=sse 用列表（每条事件 name + JSON data）；kind=text 代码块
- 顶部摘要：status badge（4xx red）、duration、replayedAt

- [ ] **Step 2：Send 按钮 & 模式切换**

在 Replay 页右侧：
- 模式切换：RadioGroup `collect | live`
- Send：
  - collect：`replayCollect(...)` → setState `lastResult`
  - live：AbortController + `replayLive(...)` onEvent 增量累积

- [ ] **Step 3：中断**

live 模式显示 "Cancel" 按钮触发 AbortController。collect 模式不提供中断（通常几百 ms 完成）。

- [ ] **Step 4：手测**

启动 `bun run dev` 后端 + `bun run dev:admin` 前端：
1. `curl`（带坏 body）触发一条 400 → 详情页看到 Replay 按钮
2. 进入 Replay 页，改 body → Send collect → 右侧 Raw 显示 400 响应
3. 切 live → Send → 增量 chunk 显示

- [ ] **Step 5：commit**

```bash
git add admin-ui/src/components/replay/replay-response-panel.tsx admin-ui/src/pages/request-replay-page.tsx
git commit -m "feat(admin-ui): add response panel and collect/live send flow"
```

---

## Task 17 — 文档 + 最终验证

**Files:**
- Modify: `AGENTS.md`（在 "Messages-Specific Notes" 或末尾追加 Replay 功能简介）
- Modify: `admin-ui/src/locales/en.json` / `zh.json`（补齐所有 `replayPage.*` 条目）

- [ ] **Step 1：补齐 i18n**

对照所有 `t("replayPage.*")` 引用 grep 一遍，确保 en + zh 全部条目存在。

```bash
grep -r "replayPage\." admin-ui/src/ | awk -F'"' '{print $2}' | sort -u
```

- [ ] **Step 2：更新 AGENTS.md**

在 `## Architecture Overview` 下追加一小节：

```markdown
### Developer Mode (Request Replay)

- 开关：`config.devMode.enabled`（主门闩）+ `config.devMode.capture4xx`（捕获开关），默认均为 false。
- 4xx 上游响应会被 `copilotFetch` helper 异步 tee 并写入 `request_outbound` 表（blob），与 `request_log` 通过 FK CASCADE 同步清理。
- Admin-UI 的 `/requests/:id/replay` 页面允许修改 body + 业务头并重放；重放不入主历史、不改 premium 配额、不写 affinity。
- 相关文件：`src/services/copilot/copilot-fetch.ts` / `src/lib/request-outbound.ts` / `src/routes/admin-api/replay.ts` / `admin-ui/src/pages/request-replay-page.tsx`。
```

- [ ] **Step 3：全量验证**

```bash
bun run lint
bun run typecheck
bun test
bun run build
```

全部通过。

- [ ] **Step 4：手测 checklist（依据 spec §9.3）**

1. `devMode.enabled=false`：详情页无 Replay 按钮；直接访问 `/requests/<id>/replay` 显示错误态；`curl` 调重放端点返回 403
2. `devMode.capture4xx=true` 下触发一次 400 → 查 SQLite：`sqlite3 ~/.local/share/copilot-api/admin.sqlite 'select count(*) from request_outbound;'` ≥ 1
3. Replay 页打开后：原账号已选中 + original badge；认证头只读 `***`
4. 改 body → Send collect → 右侧 Raw 复现 400
5. 切 live → Send → Raw Tab 增量填充；Cancel 按钮可中止
6. 切另一有效账号 → Send → DevTools Network 抓包确认 Authorization 为新账号 token
7. `sqlite3 ... "DELETE FROM request_log WHERE request_id = '<x>';"` → 再查 `request_outbound` → 无对应行

- [ ] **Step 5：commit**

```bash
git add AGENTS.md admin-ui/src/locales/en.json admin-ui/src/locales/zh.json
git commit -m "docs: document Developer Mode replay flow"
```

---

## Self-Review（计划自检记录）

- ✅ **Spec coverage**：spec 中所有 §（数据模型、捕获、Dev Mode、端点、UI、安全、测试）在 plan Task 1–17 中都有对应任务。
- ✅ **Placeholder scan**：全部步骤都有具体代码 / 命令 / 文件路径；没有 "TODO" / "similar to"。
- ✅ **Type consistency**：`OutboundCaptureInput` / `OutboundCaptureRow` / `CopilotFetchCtx` / `ReplayRequestBody` / `ReplayCollectResult` / `OutboundBlob` 在各 Task 引用时字段名一致。
- ⚠️ **已知的实施期小调整**：
  - `api-config.ts` 没有 `buildCopilotAuthHeaders` 同名 export；Task 8 中通过薄 shim `replay-auth.ts` 复用已有的 `copilotHeaders(account)`。
  - `translateStreamToAnthropic` / `translateResponsesToAnthropic` 等函数名需对照 `src/routes/messages/*translation*.ts` 的真实 export 名调整（Task 8 Step 4 已提示）。
  - `settings-page.tsx` 的 UI pattern 需参考该文件现有开关写法保持一致（Task 11 Step 2）。

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-17-admin-ui-replay-mode.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 Task 分派一个 fresh subagent 执行，两段式 code review 后再进入下一个 Task，迭代快且不会让单一 context 膨胀。

**2. Inline Execution** — 在当前会话内按顺序执行全部 17 个 Task，适合需要连续上下文记忆的情况。

**Which approach?**
