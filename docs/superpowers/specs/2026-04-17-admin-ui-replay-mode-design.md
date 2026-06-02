# Admin-UI Developer Mode: Request Replay — Design Spec

**日期**：2026-04-17
**Branch**：`all`
**Target PR**：`nick3/copilot-api`

## 1. 目标与动机

在 Admin-UI 中新增"开发者模式"，以便对**历史中返回 4xx 的上游请求**进行可交互的"修改 + 重放"调试。用户场景：看到某条请求上游返回 `4XX`，希望不离开 Admin-UI 就能改 body / 改业务头 / 换账号，再次向上游发出同一请求并查看响应，类似 RapidAPI 但基于系统内捕获的真实出站请求。

**非目标（Out of scope）**：

- 从零构造请求（纯网络调试器）。
- 捕获 5xx、2xx 或其它状态码的请求（仅 4xx）。
- 修改上游 endpoint / model / path / HTTP method / 流式开关。
- 将重放请求写入主请求历史或 premium 统计。
- 对非 `/v1/messages` 路径做 translation 展示（仅 `/v1/messages` 支持 translation 双视图）。

---

## 2. 决策对齐速查

| 维度 | 决策 |
|---|---|
| 捕获对象 | 仅 **4xx** 请求的完整 outbound body + headers；2xx/5xx 不存 |
| 存储形态 | 独立 blob 表 `request_outbound`；一对一关联 `request_log.request_id` |
| 大小上限 | **不设硬上限**（受 SQLite TEXT 限制约束即可） |
| 保留策略 | 跟随 `request_log`（35 天 / 200k 行），通过 FK `ON DELETE CASCADE` + 孤儿兜底清理 |
| 可编辑范围 | 仅 ① Request Body（JSON/text）② 业务 Header；上游 endpoint / model / path / method / stream 标志不可改 |
| 认证头 | 只读展示为 `***`；由后端按所选 account 重新注入 |
| 重放语义 | 纯旁路：不走 `selectAccountForRequest`、不 reserve/commit 配额、不写 `request_log`、不写 affinity |
| 账号选择 | UI 默认选中原账号并打 "original" badge；可切换任意启用账号 |
| UI 入口 | 独立路由 `/requests/:id/replay` |
| Developer Mode | 两个独立 config 开关：`enabled`（重放端点总开关，默认 false）+ `capture4xx`（捕获开关，默认 false） |
| 响应展示 | Tabs：Raw / Translated / Headers；Translated 仅对 `/v1/messages` 请求有效 |
| 流式 | 默认 collect（一次性），可切 live SSE |
| 重放端点 | `POST /api/admin/requests/:requestId/replay`，独立于现有业务路由 |
| 脱敏 | 写入时按白名单（Authorization / `*-token` / `*-secret` / `cookie` / `x-api-key` 等）替换为 `***`；body 原样保存 |
| 访问控制 | 现有 admin 鉴权 + `devMode.enabled` 后端硬门闩；关则 403 |

---

## 3. 架构概览

### 3.1 分层视图

```
┌────────────────────────────────────────────────────────────────┐
│  Admin-UI (React)                                              │
│  ├─ /requests/:id/replay 路由                                  │
│  │    Body 编辑器 · Header 编辑器 · 账号选择 · 响应双视图      │
│  ├─ Settings 页：Developer Mode 开关区块                       │
│  └─ Request Detail 页：Replay 入口按钮（条件显示）             │
└────────────────────────────────────────────────────────────────┘
                           │ HTTP + x-admin-token / loopback
                           ▼
┌────────────────────────────────────────────────────────────────┐
│  Admin API (Hono)                                              │
│  ├─ GET  /api/admin/dev-mode                                   │
│  ├─ POST /api/admin/dev-mode                                   │
│  ├─ GET  /api/admin/requests/:id/outbound                      │
│  └─ POST /api/admin/requests/:id/replay    (collect | live)    │
└────────────────────────────────────────────────────────────────┘
                           │
            ┌──────────────┴──────────────┐
            ▼                             ▼
  ┌─────────────────────┐       ┌────────────────────────────────┐
  │ RequestOutboundStore│       │ copilotFetch(helper)            │
  │ admin.sqlite         │◀─────│ ├─ snapshot(req) → redact        │
  │ request_outbound 表  │       │ ├─ fetch(upstream)               │
  │ (FK → request_log)   │       │ ├─ if 4xx ∧ capturable: tee+存 │
  └─────────────────────┘       │ └─ 返回原 Response               │
                                 └────────────────────────────────┘
                                           ▲
                           ┌───────────────┴────────────────┐
                           │                                │
            src/services/copilot/{messages, chat-completions,
                                  responses, embeddings, models}
```

### 3.2 请求/重放数据流

**正常请求（新增捕获）**

```
Client → handler → translation → copilotFetch(url, init)
                                    │
                                    ├─ 发送前：snapshot(init)
                                    └─ 响应后：若 400 ≤ status < 500 ∧ capture4xx=true
                                               → tee() 副本 → 异步写 request_outbound
                                    （2xx 路径零额外开销）
```

**重放（旁路）**

```
UI POST /api/admin/requests/:id/replay
  Body: { accountId, overrides: { body?, headers? }, mode: "collect" | "live" }
        │
        ▼
Admin API:
  ① 校验 devMode.enabled === true；否则 403
  ② 加载 request_outbound blob + join request_log 取 original 元数据；缺失 → 404
  ③ 校验 accountId 对应的账号有效且启用
  ④ 应用 overrides（body 整替换 / header 合并）
  ⑤ injectAuthHeaders：删除脱敏占位 "***"，按账号注入真实 token
  ⑥ 调 copilotFetch(url, init, { callSite: "replay", capturable: false })
  ⑦ collect → 完整读取 upstream body，返回 { raw, translated?, status, headers, durationMs }
     live    → SSE 转发给前端，流结束追加 translated 事件
  ⑧ 不写 request_log / daily_premium_stats / session_affinity
```

### 3.3 模块清单

**新增**

- `src/lib/request-outbound.ts` — blob 表 CRUD + 脱敏白名单
- `src/lib/dev-mode.ts` — Developer Mode 状态读写（薄包装 config）
- `src/services/copilot/copilot-fetch.ts` — 统一上游调用 helper + 捕获
- `src/routes/admin-api/replay.ts` — Dev Mode / Outbound / Replay 端点集
- `admin-ui/src/pages/request-replay-page.tsx` — 重放页容器
- `admin-ui/src/components/replay/replay-context-card.tsx`
- `admin-ui/src/components/replay/replay-account-select.tsx`
- `admin-ui/src/components/replay/replay-headers-editor.tsx`
- `admin-ui/src/components/replay/replay-body-editor.tsx`
- `admin-ui/src/components/replay/replay-response-panel.tsx`
- `admin-ui/src/components/replay/replay-live-stream.tsx`
- `admin-ui/src/lib/sse.ts` — SSE 解析 util

**修改**

- `src/lib/admin-db.ts` — migration v11：新建 `request_outbound` 表、索引、FK；`PRAGMA foreign_keys = ON`
- `src/lib/config.ts` — 新增 `devMode?: { enabled: boolean; capture4xx: boolean }`
- `src/routes/admin-api/route.ts` — 挂载 replay 子路由
- `src/services/copilot/{create-messages,create-chat-completions,create-responses,create-embeddings,get-models}.ts` — `fetch(...)` → `copilotFetch(...)`；embeddings / models 传 `capturable: false`
- `admin-ui/src/App.tsx` — 注册 `/requests/:id/replay` 路由
- `admin-ui/src/pages/request-detail-page.tsx` — 加 Replay 按钮（条件显示）
- `admin-ui/src/pages/settings-page.tsx` — 加 Developer Mode 开关区块
- `admin-ui/src/lib/admin-api.ts` — 增加 dev-mode / outbound / replay 客户端函数
- `admin-ui/src/locales/*` — i18n 文案（`replayPage.*` 命名空间）

---

## 4. 数据模型与持久化

### 4.1 `request_outbound` 表

```sql
CREATE TABLE IF NOT EXISTS request_outbound (
  request_id         TEXT    PRIMARY KEY,
  captured_at_ms     INTEGER NOT NULL,
  http_status        INTEGER NOT NULL,

  upstream_url       TEXT    NOT NULL,
  upstream_method    TEXT    NOT NULL,

  request_headers    TEXT    NOT NULL,             -- JSON object; sensitive keys = "***"
  request_body       TEXT,                          -- raw body text (nullable)
  request_body_kind  TEXT    NOT NULL,             -- "json" | "text" | "binary"

  response_status    INTEGER NOT NULL,
  response_headers   TEXT    NOT NULL,             -- JSON object
  response_body      TEXT,                          -- raw upstream body (may be large)
  response_body_kind TEXT    NOT NULL,             -- "json" | "sse" | "text"

  FOREIGN KEY (request_id) REFERENCES request_log(request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_request_outbound_captured_at
  ON request_outbound(captured_at_ms DESC);
```

Migration 方法：新增 `migrateV11`；在 `getAdminDb()` 初始化处追加 `db.run("PRAGMA foreign_keys = ON;")`（仅对连接生效，需保证单例连接贯穿整个进程）。

### 4.2 保留策略

- `request_log` 现有清理路径（35 天 / 200k 行）不变。
- 依赖 `ON DELETE CASCADE`：`request_log` 行被删时，`request_outbound` 自动同步删除。
- 每日清理时额外跑孤儿兜底 SQL：`DELETE FROM request_outbound WHERE request_id NOT IN (SELECT request_id FROM request_log);`（防御历史 DB 未开 FK 的残留）。

### 4.3 脱敏白名单

写入时应用；以正则匹配 HTTP 头 key（大小写不敏感）：

```
^authorization$
^x-github-token$
^cookie$
^set-cookie$
^proxy-authorization$
^x-api-key$
-token$
-secret$
```

未匹配的头原样保存。body 不做脱敏（保留调试可读性；依靠 admin 鉴权 + 保留策略）。

### 4.4 Store API

```ts
// src/lib/request-outbound.ts

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
  insert(input: OutboundCaptureInput): void       // 内部脱敏 + 吞异常 + 节流 warn
  getByRequestId(requestId: string): OutboundCaptureRow | null
  cleanupOrphans(): void
}

export function getRequestOutboundStore(): RequestOutboundStoreApi
```

失败模式与 `RequestHistoryStore` 对齐：init-on-demand、失败降级为 disabled stub、节流 warn。

---

## 5. 捕获层：`copilotFetch` helper

### 5.1 签名

```ts
// src/services/copilot/copilot-fetch.ts

export type CopilotFetchCtx = {
  requestId?: string
  capturable?: boolean        // 默认 true；与 config.devMode.capture4xx 取 AND
  callSite: string            // "messages" | "chat-completions" | "responses" | "embeddings" | "models" | "replay"
}

export async function copilotFetch(
  input: string | URL,
  init: RequestInit,
  ctx: CopilotFetchCtx,
): Promise<Response>
```

### 5.2 捕获判定

```ts
const shouldCapture =
  ctx.requestId != null
  && ctx.capturable !== false
  && getConfig().devMode?.capture4xx === true
  && response.status >= 400
  && response.status < 500
```

2xx / 5xx / 抛异常路径下一律跳过捕获，无额外开销。

### 5.3 快照实现

**Request snapshot**：
- headers：规范化为 `Record<string, string>`（支持 Headers / array / plain object 三种来源）
- body：Copilot 客户端全部使用 `JSON.stringify(...)`，命中 `kind: "json"`；保留 `text` / `binary (base64)` 分支做防御
- 对 `ReadableStream` / `FormData` 类 body 放弃 body 捕获（仅存 headers）

**Response 分叉**：使用 `response.body.tee()` 得到两个独立 stream；一支构造新 `Response` 返回给调用方，另一支异步全读后写 blob。4xx 响应通常 < 10 KB，内存成本可接受。

### 5.4 写入时序

捕获副本在**异步** IIFE 中读取（`void (async () => { ... })()`），不阻塞主响应。写入失败吞掉并 `consola.debug`，捕获逻辑对主请求**零影响**。

### 5.5 调用点迁移

| 文件 | `callSite` | `capturable` |
|---|---|---|
| `create-messages.ts` | `"messages"` | `true`（默认） |
| `create-chat-completions.ts` | `"chat-completions"` | `true` |
| `create-responses.ts` | `"responses"` | `true` |
| `create-embeddings.ts` | `"embeddings"` | `false` |
| `get-models.ts` | `"models"` | `false` |

`requestId` 从 `request-context.ts` 的 AsyncLocalStorage 取，与现有 `consumeOutboundHeadersSnapshot()` 机制同源。

---

## 6. Developer Mode 与端点

### 6.1 Config 字段

```ts
// src/lib/config.ts
type DevModeConfig = {
  enabled: boolean       // 主开关：控制重放相关端点是否可用
  capture4xx: boolean    // 捕获开关：控制是否写 request_outbound
}

interface AppConfig {
  // ...
  devMode?: DevModeConfig   // 默认 { enabled: false, capture4xx: false }
}
```

两开关独立：可只采集、只重放、或都开/都关。

### 6.2 Dev Mode 端点

不受 `devMode.enabled` 门闩限制，只受现有 admin 鉴权保护；否则无法开启。

- `GET /api/admin/dev-mode` → `{ enabled, capture4xx }`
- `POST /api/admin/dev-mode` body `{ enabled?: boolean; capture4xx?: boolean }` → 写 config.json，返回新状态

### 6.3 Outbound 读取端点

- `GET /api/admin/requests/:requestId/outbound`
- 要求 `devMode.enabled === true`；否则 403
- 返回：blob 字段 + join 自 `request_log` 的只读上下文（`path`, `upstream_endpoint`, `upstream_model`, `account_id`, `client_model`）
- 额外返回 `redacted_header_keys: string[]`，便于前端判定只读
- 404 if blob 不存在

### 6.4 Replay 端点

`POST /api/admin/requests/:requestId/replay`，要求 `devMode.enabled === true`。

**请求体**：
```ts
{
  accountId: string,
  overrides?: {
    body?: string,
    headers?: Record<string, string>
  },
  mode: "collect" | "live"
}
```

**Collect 响应**（`application/json`）：
```ts
{
  status: number,
  statusText: string,
  headers: Record<string, string>,
  raw: { body: string, kind: "json" | "sse" | "text" },
  translated?: TranslatedView | { error: string } | null,
  durationMs: number,
  replayedAt: number
}
```

**Live 响应**（`text/event-stream`）：
```
event: upstream-start     data: {"status":..., "headers":{...}}
event: upstream-chunk     data: {"raw":"..."}
... (多次)
event: upstream-done      data: {"durationMs":...}
event: translated         data: {... | {"error":"..."}}
```

**执行逻辑**（伪代码，实现分散到 `replay.ts`）：

```ts
async function handleReplay(c: Context) {
  if (!getConfig().devMode?.enabled) return json403("Developer mode disabled")

  const blob = outboundStore.getByRequestId(requestId)
  if (!blob) return json404("No outbound captured for this request")

  const original = requestHistoryStore.getByRequestId(requestId)
  if (!original) return json404("Original request log missing")

  const { accountId, overrides, mode } = await parseBody(c)
  const account = accountsManager.getAccountById(accountId)
  if (!account || !account.enabled) return json400("Account not available")

  const mergedHeaders = { ...blob.requestHeaders, ...(overrides?.headers ?? {}) }
  const bodyText = overrides?.body ?? blob.requestBody
  if (blob.requestBodyKind === "json" && bodyText) assertValidJson(bodyText)  // 400 on fail

  const finalHeaders = await injectAuthHeaders(mergedHeaders, account)  // 删除 "***"，注入真实 token

  const startMs = Date.now()
  const upstreamRes = await copilotFetch(
    blob.upstreamUrl,
    { method: blob.upstreamMethod, headers: finalHeaders, body: bodyText },
    { callSite: "replay", capturable: false },
  )

  return mode === "live"
    ? streamAndRespond(c, upstreamRes, original, startMs)
    : collectAndRespond(c, upstreamRes, original, startMs)
}
```

### 6.5 Translation 薄层

`translateForReplay({ upstreamEndpoint, rawText, rawKind })`：

- `/chat/completions` + json → `translateOpenAIToAnthropic(JSON.parse(rawText))`
- `/chat/completions` + sse → 走 `stream-translation.ts` 累积 chunk → Anthropic 事件数组
- `/v1/messages` + * → 恒等映射（raw 即 translated）
- `/responses` + * → `responses-translation.ts`

translation 抛异常 → 返回 `{ error: message }`；不影响 raw 字段。

### 6.6 `injectAuthHeaders`

```ts
async function injectAuthHeaders(
  base: Record<string, string>,
  account: AccountContext,
): Promise<Record<string, string>> {
  const out = { ...base }
  for (const key of Object.keys(out)) {
    if (out[key] === "***") delete out[key]
  }
  const authHeaders = buildCopilotAuthHeaders(await account.getCopilotToken(), account)
  Object.assign(out, authHeaders)   // 覆盖顺序：authHeaders 最后，永远不会被用户 override
  return out
}
```

复用 `src/lib/api-config.ts` 中现有的 header 构造逻辑。

### 6.7 错误响应形状

统一：`{ error: { message: string, type: "bad_request" | "forbidden" | "not_found" | "upstream_error" | "internal_error" } }`

| 场景 | Status | Type |
|---|---|---|
| devMode 关 | 403 | forbidden |
| blob 缺失 | 404 | not_found |
| account 无效 | 400 | bad_request |
| body JSON 非法 | 400 | bad_request |
| 上游 fetch 异常 | 502 | upstream_error |
| translation 异常 | 200（raw 保留，translated.error） | — |

---

## 7. Admin-UI

### 7.1 路由 & 入口

- 新路由：`/requests/:requestId/replay` → `RequestReplayPage`
- 请求详情页顶部工具栏加 **Replay** 按钮，条件显示：
  - `devMode.enabled === true`
  - 该 request 有 blob（懒加载：`GET /requests/:id/outbound` 预检，或把"has_outbound"字段加到 `GET /requests/:id`）
  - 不满足时隐藏；条件 1 满足 / 2 不满足时按钮禁用 + tooltip 说明
- Settings 页新增 **Developer Mode** 区块：两个开关 + 存储容量/敏感性警告文案。`capture4xx` 仅在 `enabled=true` 时可勾选。

### 7.2 Replay 页布局

- 左右分栏（`lg` 以上）；`md` 以下垂直堆叠
- 左侧：Context 卡片（只读）、Account 选择、Headers 编辑器（业务头可编辑 + 认证头只读 `***`）、Body 编辑器
- 右侧：Response Panel（Tabs：Raw / Translated / Headers）+ mode 切换（collect/live）+ status/duration 摘要

### 7.3 组件

| 组件 | 职责 |
|---|---|
| `RequestReplayPage` | 路由容器、编排 state、加载 blob/accounts/devMode |
| `ReplayContextCard` | 只读 path / endpoint / model / original request_id |
| `ReplayAccountSelect` | 账号下拉；原账号置顶并打 original badge；失败账号灰色 + tooltip |
| `ReplayHeadersEditor` | 键值对列表；`redacted_header_keys` 列表内的行锁定为只读 `***`；新增键阻止命中敏感模式 |
| `ReplayBodyEditor` | JSON editor（codemirror-json）/ textarea / binary 只读；Format + Reset 操作 |
| `ReplayResponsePanel` | 三 Tab；Translated 对非 `/v1/messages` 灰掉 + 提示 |
| `ReplayLiveStream` | 用 fetch + ReadableStream 解析 SSE，分发给 Response Panel |

### 7.4 状态机

```ts
type ReplayState =
  | { phase: "loading-blob" }
  | { phase: "no-blob" }
  | { phase: "ready",     form: ReplayForm, lastResult?: ReplayResult }
  | { phase: "sending",   form: ReplayForm }
  | { phase: "streaming", form: ReplayForm, partial: ReplayPartial }
  | { phase: "error",     message: string, form?: ReplayForm }
```

### 7.5 关键 UX 规则

- Headers 编辑器：前端依据 `redacted_header_keys` 禁止编辑/删除这些 key，也禁止通过新增按钮引入任何匹配敏感模式的 key
- Body 编辑器：kind=`json` 时 Send 前 `JSON.parse` 校验，失败提示位置；kind=`binary` 时 Send 按钮禁用（或保持原 base64 不变发送）
- Live 模式通过 fetch + 手解 SSE 实现（EventSource 不支持自定义 `x-admin-token`）
- Send 按钮支持 AbortController，live 模式可取消
- 离开页面前表单有未保存编辑 → `beforeunload` 确认

### 7.6 i18n

新增 `replayPage.*` 命名空间覆盖全部按钮/字段/tooltip/错误文案；同步更新 en + zh。`settings-page.tsx` 的 Developer Mode 区块也走 i18n。

---

## 8. 安全与不变量

### 8.1 威胁矩阵

| 威胁 | 缓解 |
|---|---|
| admin.sqlite 泄露 → Copilot token 暴露 | 脱敏白名单 + config 默认关闭捕获 |
| 用户 prompt 敏感 | admin 鉴权 + 默认 capture4xx=false + 35 天清理 |
| 远程攻击者滥用重放端点 | 现有 admin 鉴权 + `devMode.enabled` 硬门闩默认关 |
| 前端 CSRF | 现有 same-origin 检查 + devMode 双保险 |
| 用户伪造 Authorization 头 | 前端屏蔽敏感键新增 + 后端 `injectAuthHeaders` 最后覆盖 |
| 重放污染生产统计 | 重放端点不调用 history/stats/affinity 相关 store；`capturable: false` 阻止回环捕获 |
| 上游 GitHub 真实配额消耗 | 不可避免；UI 在 Send 处明确 tooltip 提示 |

### 8.2 必须成立的不变量

1. 2xx 响应永不写 `request_outbound`
2. 重放调用产生的上游响应永不写 `request_outbound`
3. 重放端点永不写 `request_log` / `daily_premium_stats` / `session_affinity`
4. 用户提供的 Authorization 及同类头永远不会出现在 wire 上（`injectAuthHeaders` 最后一步覆盖）
5. `"***"` 值永远不会出现在 wire 上（`injectAuthHeaders` 删除所有 `"***"` 值）
6. `request_outbound` 表不存在孤儿行（FK CASCADE + 孤儿清理双保险）
7. `devMode.enabled=false` 时重放/outbound 端点一律 403（即使请求带合法 ADMIN_TOKEN）
8. `devMode.capture4xx=false` 时 `copilotFetch` 不读/不写 blob 相关路径

每条不变量对应至少一个测试用例（见 §9）。

### 8.3 可观测性

- 捕获失败：节流 `consola.warn("Failed to persist outbound capture")`
- 重放开始：`consola.info({ originalRequestId, replayAccountId, mode })`
- 重放上游错误：`consola.warn({ originalRequestId, status, durationMs })`
- Replay 自身生成新 trace id（`replay-<uuid>`）以便在日志中与原始请求区分

---

## 9. 测试策略

### 9.1 Unit / Integration

| 文件 | 关键用例 |
|---|---|
| `tests/copilot-fetch.test.ts` | 2xx 不捕获；4xx JSON 捕获；4xx SSE 捕获；5xx 不捕获；capturable=false 不捕获；capture4xx=false 不捕获；无 requestId 不捕获；tee 后调用方 body byte-identical |
| `tests/request-outbound-store.test.ts` | insert/get 往返；脱敏白名单（列举所有敏感 pattern）；非敏感头原样；cleanupOrphans |
| `tests/outbound-redaction.test.ts` | 真实 outbound header fixture → 所有 token/secret/auth 字段被脱敏 |
| `tests/replay-handler.test.ts` | devMode 关 → 403；blob 缺失 → 404；account 无效 → 400；body 非法 JSON → 400；成功路径 collect；outgoing request 无 `***`；spy 断言不写 request_log/stats |
| `tests/replay-stream.test.ts` | live 模式：mock SSE chunks → 客户端收到 start/chunk×N/done/translated 顺序 |
| `tests/dev-mode-config.test.ts` | enabled/capture4xx 独立；持久化；默认 false/false |
| `tests/admin-db-migrations.test.ts`（新建或扩展） | migration v11 建表、索引、FK CASCADE 生效 |
| 扩展 `tests/messages-handler.test.ts` | capture4xx=true + 上游 4xx → outbound 有行；2xx → 无行 |

### 9.2 UI 组件层

| 文件 | 用例 |
|---|---|
| `admin-ui/tests/replay-headers-editor.test.tsx` | 只读/可编辑判定；敏感 key 新增被拒；case-insensitive 合并提示 |
| `admin-ui/tests/replay-body-editor.test.tsx` | Format / Reset；非法 JSON 阻断 Send |
| `admin-ui/tests/replay-response-panel.test.tsx` | 三 Tab 渲染；live 事件增量 |

### 9.3 手测 checklist（评审用）

1. `devMode.enabled=false`：详情页无 Replay 按钮；`POST replay` 返回 403
2. `devMode.capture4xx=true`：触发一次 400 上游错误 → `request_outbound` 可查到记录
3. 打开 Replay 页：原账号已选中并带 original badge；认证头只读展示 `***`
4. 修改 body / 业务头 → Send（collect）→ 上游 4xx 被复现
5. 切 live 模式 → UI 增量显示 chunk；中断按钮可取消
6. 切换到另一有效账号 → Send → DevTools 抓包确认 Authorization 为新账号 token
7. 触发主表清理（或 mock 清理）→ 对应 outbound 行同步消失

---

## 10. 落地顺序

1. admin-db migration v11 + `request-outbound.ts` store
2. `copilot-fetch.ts` helper + 迁移 5 个 service 客户端
3. dev-mode config + `/api/admin/dev-mode` 端点
4. `/api/admin/requests/:id/outbound` 端点
5. `/api/admin/requests/:id/replay` collect 模式
6. Replay 端点 live 模式
7. Admin-UI：Settings 开关 + 详情页 Replay 按钮
8. Replay 页面（编辑器 + 响应面板）
9. 手测 + i18n 补全

每步完成后：`bun run lint` + `bun test` + `bun run typecheck`；第 8 步后跑 `bun run build`。

---

## 11. 附录：不做的事（显式划界）

- 不捕获 2xx/5xx/非 HTTP 错误
- 不支持重放时修改 path / method / upstream endpoint / model / stream 标志
- 不对 body 做敏感词/PII 脱敏
- 不为重放执行引入独立的 rate-limit（依靠 GitHub 上游自身节流）
- 不把重放结果写回主请求历史或 premium 统计
- 不新增独立的 admin-token for replay（复用现有 admin 鉴权）
- 不做 outbound 表大小封顶（仅依赖主表清理级联）
- 当前版本不做 translation 层双向复现的回归覆盖（translation 单元测试在 messages 路径已有）
