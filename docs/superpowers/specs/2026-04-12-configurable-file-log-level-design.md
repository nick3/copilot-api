# Configurable File Log Level

## Problem

当前项目已经会把部分 handler 日志写到运行时数据目录下的 `logs/`，具体路径来自 `PATHS.APP_DIR/logs`。这些文件日志由 `src/lib/logger.ts` 的 `createHandlerLogger()` 统一生成，文件名按 `handler-name-YYYY-MM-DD.log` 滚动。

但“哪些内容会被写入日志文件”目前不是一个显式的持久化配置：

- `info` / `warn` / `error` 级别会随着当前 logger 行为直接落盘
- `debugJson()` / `debugJsonTail()` / `debugLazy()` 这类重 payload 调试日志依赖 `state.verbose`
- 因此文件日志详细度实际上被启动时的 `--verbose` 间接控制，而不是由 `config.json` 明确控制

这带来两个问题：

1. **配置语义不清晰**：用户想控制文件日志写入内容，却必须理解 `--verbose` 与 file logger 的隐式耦合。
2. **行为不可预期**：想临时打开运行时调试时，可能顺手把 handler 文件日志也提升到更详细级别，写入更多请求/响应内容。

本次需求要求新增一个明确的配置项，让用户能够通过 `config.json` 控制哪些级别会写入日志文件。

---

## Goals

1. 新增持久化配置项 `logLevel`，用于控制文件日志落盘级别。
2. 支持四个明确级别：`error`、`warn`、`info`、`debug`。
3. 保持现有日志目录、命名格式、buffer flush 和保留策略不变。
4. 尽量不改各个 handler 的调用点，把改动集中在配置层和 logger 底层。
5. 让现有 `/api/admin/config` 读写链路支持 `logLevel`。
6. 默认行为尽量与当前项目一致：默认写入 `info/warn/error`，只有 `debug` 需要显式开启。

## Non-Goals

1. 本次不增加 Admin UI 的可视化控件。
2. 本次不支持按 handler 配置不同日志级别。
3. 本次不重构 console logging 体系，也不重新定义 `--verbose` 的 console 语义。
4. 本次不修改日志行格式、traceId 拼接规则、日志文件切分方式或保留天数。
5. 本次不处理“外部直接手改 `config.json` 后自动热加载”的通用配置监听问题。

---

## Current Behavior Summary

### 1. 文件日志集中落在 `src/lib/logger.ts`

当前 `createHandlerLogger()` 会：

- 将日志文件写到 `path.join(PATHS.APP_DIR, "logs")`
- 以 `sanitizedName + dateKey` 生成文件名
- 通过内存 buffer 聚合后再刷盘
- 在进程退出、定时 flush、定时清理旧文件时处理收尾

### 2. debug payload 依赖 `state.verbose`

`debugLazy()` / `debugJson()` / `debugJsonTail()` 目前在 `state.verbose === false` 时直接跳过，不会执行 JSON 序列化，也不会调用 `logger.debug()`。

这使得如下内容只有在 verbose 模式下才会进入文件日志：

- 请求 payload
- 响应 payload
- stream chunk / raw event
- 翻译前后事件体等重内容日志

### 3. `/api/admin/config` 已有可复用的配置读写通道

当前 Admin API 已支持：

- `GET /api/admin/config`：返回合并默认值后的配置
- `POST /api/admin/config`：校验请求体并写回 `config.json`

因此新增 `logLevel` 不需要重新设计配置入口，只需要扩展已有 `AppConfig`、默认值、patch handler 和校验逻辑。

---

## Design

## Core Rule

新增配置项：

```ts
logLevel?: "error" | "warn" | "info" | "debug"
```

它的语义是：

> **决定哪些日志级别允许写入文件日志。**

级别行为如下：

- `error`：只写 `error`
- `warn`：写 `warn` 和 `error`
- `info`：写 `info`、`warn`、`error`
- `debug`：写全部，包括 `debug`

默认值为：

```ts
logLevel: "info"
```

这样可以尽量保持当前默认行为不变。

---

## Scope Boundary

### `logLevel` 控制 handler 文件日志内容的发射与落盘

本次设计明确把“handler 文件日志内容”与“运行时 verbose 模式”拆开：

- `logLevel`：控制 `logs/*.log` 里哪些级别能够被发射并最终落盘
- `--verbose`：继续保留为运行时调试 / console 相关语义

也就是说，`--verbose` **不再隐式把 handler 文件日志抬到 `debug`**。

如果用户想让文件日志中出现 request/response payload 之类的 debug 内容，需要显式把：

```json
{
  "logLevel": "debug"
}
```

写入配置。

### 保持现有 logger 调用点不变

现有 handler 中的这些调用方式尽量不改：

- `logger.info(...)`
- `logger.warn(...)`
- `logger.error(...)`
- `logger.debug(...)`
- `debugJson(...)`
- `debugJsonTail(...)`
- `debugLazy(...)`

控制逻辑统一收敛到 `src/lib/logger.ts` 和 `src/lib/config.ts`，避免把日志级别判断扩散到业务 handler。

---

## Configuration Model

### 1. 扩展 `AppConfig`

在 `src/lib/config.ts` 中新增：

- `type LogLevel = "error" | "warn" | "info" | "debug"`
- `logLevel?: LogLevel`

### 2. 默认值合并

在 `defaultConfig` 中新增：

```ts
logLevel: "info"
```

并增加一段默认值合并逻辑，使旧配置文件在没有该字段时自动补齐为 `info`。

推荐做法是新增一个与 `modelRefreshIntervalHours`、`sessionAffinityRetentionDays` 类似的 merge helper，例如：

```ts
function mergeDefaultLogLevel(config: AppConfig): ConfigMergeResult
```

这样可以保持现有配置合并风格一致，而不是把 `logLevel` 夹杂进无关的 merge 函数里。

### 3. 读取 helper

新增：

```ts
export function getLogLevel(): LogLevel
```

行为：

- 读取 `getConfig().logLevel`
- 对缺失或非法值回退到 `defaultConfig.logLevel`
- 始终返回一个合法枚举值

---

## Runtime Behavior

### 1. 在 logger reporter 中统一做级别过滤

`src/lib/logger.ts` 新增一套内部级别映射，例如：

```ts
const FILE_LOG_LEVEL_PRIORITY = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
} as const
```

并新增 helper：

```ts
function normalizeLogTypeToLevel(type: string): LogLevel
function shouldWriteFileLog(type: string): boolean
```

映射规则建议为：

- `error` -> `error`
- `warn` -> `warn`
- `info` / `log` / `success` -> `info`
- `debug` -> `debug`
- 未识别类型 -> `info`

Reporter 在真正 `appendLine()` 之前先调用 `shouldWriteFileLog(logObj.type)`；不满足条件则直接跳过，不进入 buffer。

### 2. `debugJson*` 改为基于 `logLevel` 控制

当前 `debugLazy()` 通过 `state.verbose` 决定是否执行 factory。为了让 `logLevel: "debug"` 真正能独立控制文件 debug 内容，本次改为：

```ts
function isFileDebugLoggingEnabled(): boolean
```

其语义为：

```ts
getLogLevel() === "debug"
```

然后：

- `debugLazy()` 只在 file debug 启用时执行 factory
- `debugJson()` / `debugJsonTail()` 继续复用 `debugLazy()`

这样可以同时满足两点：

1. `logLevel !== "debug"` 时不做重 payload 序列化
2. `logLevel === "debug"` 时即使没有 `--verbose`，文件日志仍会得到完整 debug 内容

### 3. handler logger 不再把 `state.verbose` 作为文件详细度来源

`createHandlerLogger()` 当前会在 `state.verbose` 时提高 instance level。改造后，文件日志详细度不再依赖这个布尔值。

推荐做法：

- 让 handler logger 始终具备足够高的内部发射能力
- 再由 file reporter 根据 `logLevel` 决定是否真正落盘

这样可以让“发射什么日志”和“最终是否落盘”分层清晰。

### 4. 配置生效时机

- 通过 `/api/admin/config` 更新 `logLevel` 时，现有写回逻辑会重新执行 `mergeConfigWithDefaults()` 并刷新缓存，因此**同进程内可以立即生效**。
- 直接在磁盘上手改 `config.json` 而不走现有配置写回链路时，仍然沿用项目当前配置缓存行为；通常需要重启或触发已有配置刷新流程。

这与项目当前其它配置项的语义保持一致，不额外引入配置文件监听器。

---

## Admin API Changes

### 1. 扩展允许的 config key

在 `src/routes/admin-api/route.ts` 中：

- 将 `logLevel` 加入 `CONFIG_KEYS`
- 将 `logLevel` 加入 `CONFIG_PATCH_HANDLERS`

### 2. 增加校验逻辑

新增一个小型 validator，例如：

```ts
function applyOptionalLogLevel(
  target: AppConfig,
  field: "logLevel",
  value: unknown,
): string | undefined
```

行为：

- 接受 `"error" | "warn" | "info" | "debug"`
- 拒绝其他字符串
- 拒绝非字符串类型
- 错误时返回与现有 config patch handler 风格一致的字段错误消息

这样 `POST /api/admin/config` 可以稳定地接受合法值并拒绝非法值。

### 3. 第一阶段不改 Admin UI

本次 spec 不包含：

- Admin UI 表单新增日志级别下拉框
- 前端页面文案或帮助提示

原因：

- 当前需求核心是“后端配置能力”
- 现有 API 已足够满足配置入口
- 把 UI 一起纳入会扩大改动范围，且不是必须条件

如果后续需要 UI，只要在已有 `/api/admin/config` 的基础上补前端字段即可。

---

## Behavior Matrix

### Case A — `logLevel = "error"`

写入文件：

- `logger.error(...)`

跳过：

- `warn`
- `info`
- `debug`
- `debugJson*`

### Case B — `logLevel = "warn"`

写入文件：

- `error`
- `warn`

跳过：

- `info`
- `debug`
- `debugJson*`

### Case C — `logLevel = "info"`

写入文件：

- `error`
- `warn`
- `info`

跳过：

- `debug`
- `debugJson*`

这是默认行为，也是当前项目最接近的既有语义。

### Case D — `logLevel = "debug"`

写入文件：

- `error`
- `warn`
- `info`
- `debug`
- `debugJson*` 生成的请求/响应 payload 等重内容

这时文件日志会最详细，适合定向排查协议转换、stream event、payload 问题。

---

## Testing Plan

### 1. `tests/logger.test.ts`

新增或调整测试覆盖：

- `logLevel !== "debug"` 时，`debugJson()` 不触发序列化
- `logLevel === "debug"` 时，`debugJson()` 会写出 JSON 字符串
- `shouldWriteFileLog()` 的级别映射
  - `error` 只允许 `error`
  - `warn` 允许 `warn/error`
  - `info` 允许 `info/warn/error`
  - `debug` 允许全部
- `createHandlerLogger()` 的 direct debug 路径
  - `logLevel = "info"` 时，直接 `logger.debug(...)` 不应进入文件 buffer
  - `logLevel = "debug"` 时，直接 `logger.debug(...)` 应进入文件 buffer / reporter 流程

### 2. `tests/admin-config.test.ts`

新增测试：

- `POST /api/admin/config` 可以写入 `logLevel: "warn"`
- `GET /api/admin/config` 返回合并后的 `logLevel`
- 非法值（例如 `"trace"`）被 400 拒绝

### 3. 轻量配置默认值测试

如果现有测试分布允许，补一个配置测试验证：

- 当 `config.json` 缺失 `logLevel` 时，合并默认值后得到 `"info"`

### 4. 不额外引入高成本集成测试

本次不要求新增真实文件刷盘级别的端到端测试，原因是：

- 现有 logger 已有独立单元测试入口
- 本次改动集中在配置映射和 reporter 过滤
- 通过 unit + admin config API 测试即可覆盖主要行为

如果后续出现回归，再考虑补专门的文件级集成测试。

---

## Risks and Mitigations

### 风险 1：`debugJson*` 改造后改变现有 verbose 习惯

**表现：** 以前某些用户依赖 `--verbose` 看到文件 debug，如今需要显式配 `logLevel: "debug"`。

**缓解：**

- 在 README / 配置说明中补一句：文件日志详细度改由 `logLevel` 控制
- 保持默认 `info`，避免普通用户行为变化过大

### 风险 2：未知 log type 被错误降级或丢弃

**表现：** 如果后续新增了 `consola` 的其他 log type，可能出现过滤判断不符合预期。

**缓解：**

- 对未知类型统一映射为 `info`
- 这样比“直接丢弃”更安全，也更接近现有宽松行为

### 风险 3：配置入口扩展不完整

**表现：** `AppConfig` 已支持 `logLevel`，但 Admin API 漏了 `CONFIG_KEYS` 或 patch handler，导致运行时报 unknown key。

**缓解：**

- 明确把 `AppConfig`、default merge、`getLogLevel()`、`CONFIG_KEYS`、`CONFIG_PATCH_HANDLERS` 作为一个不可拆分的最小改动组
- 用 `tests/admin-config.test.ts` 覆盖这个链路

---

## Summary

本次设计采用一个最小、明确、可维护的方案：

- 用 `config.json.logLevel` 明确控制文件日志写入级别
- 默认值设为 `info`，尽量保持既有行为
- 文件日志与 `--verbose` 解耦，避免隐式副作用
- 通过底层 logger 过滤、direct `logger.debug(...)` 控制与 `debugJson*` gating 完成实现，尽量不改业务 handler
- 复用现有 `/api/admin/config` 作为配置入口，不在第一阶段扩展 Admin UI

这个方案满足当前需求，同时给后续扩展（例如 Admin UI 或 per-handler 级别）保留了清晰的演进路径。