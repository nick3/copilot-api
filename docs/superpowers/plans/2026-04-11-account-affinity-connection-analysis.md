# Account Affinity / Connection Ownership 修复 - 实施计划

> **For agentic workers:** 推荐按阶段执行，并在每个阶段完成后单独回归测试与审查。

**Goal:** 修复 stateful 请求跨账号误路由导致的 `401 does not belong to this connection`，同时补齐最小 observability，便于后续验证与排障。

**Architecture:** 复用现有 `account-affinity` + `accounts-manager` 选路架构，不引入新的持久化 affinity store。第一阶段先修正 401 分类并统一三条入口的 session-level affinity key；第二阶段把关键观测字段落库到 `request_log`；第三阶段再暴露到 admin API / UI，并补齐回归验证。

**Tech Stack:** TypeScript、Hono、Bun、SQLite、React admin UI

---

## Context

分析文档 `docs/superpowers/specs/2026-04-11-account-affinity-connection-analysis.md` 已确认：当前主因不是“文本上下文像不像同一个会话”，而是**请求中回传了上游生成的 stateful item IDs，但部分请求被路由到了不拥有这些 IDs 的上游账号**。当前仓库里，`/v1/messages`、`/v1/responses`、`/v1/chat/completions` 的 affinity key 推导方式不一致，同时所有 401 基本都被视为真正的 unauthorized，并可能触发 `markAccountFailed(...)`，从而把跨账号误路由进一步放大成“账号坏了”。

本计划的核心目标是三件事：

1. 先把 ownership mismatch 401 与真正 unauthorized 401 分开。
2. 再让三条 stateful 入口统一使用稳定的 session-level affinity key。
3. 最后把足够的观测信息落库并暴露到 admin 侧，用现有 request log 证明修复生效。

---

## Phase 1 — 401 分类止损

### Task 1: 区分 ownership mismatch 401 与真正 unauthorized 401

**Files:**
- Modify: `src/lib/handler-utils.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/embeddings/route.ts`
- Test: `tests/handler-utils.test.ts`（新增）
- Test: `tests/messages-handler.test.ts`

**Implementation notes:**
- 在 `src/lib/handler-utils.ts` 扩展 `extractErrorDetails()`，新增 ownership mismatch 判定位（依据上游 message，如 `does not belong to this connection`）。
- 保留现有 `unauthorized` 语义，但让 handler 能区分：
  - 真实 token/account unauthorized → 允许 `markAccountFailed(...)`
  - ownership mismatch → 记录错误，不标记账号失败
- 所有现有 `markAccountFailed(..., "Unauthorized (401)")` 分支都要统一收口到这个判定结果，避免不同入口继续各自复制判断逻辑。

**Verification:**
- `tests/handler-utils.test.ts` 覆盖至少两类 401：
  - `input item ID does not belong to this connection`
  - 真实 token 失效 / unauthorized
- `tests/messages-handler.test.ts` 验证 ownership mismatch 不再触发 account failed。

---

## Phase 2 — 统一三条入口的 session-level affinity key

### Task 2: 收敛 affinity key 推导逻辑到单一 helper

**Files:**
- Modify: `src/lib/utils.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Test: `tests/utils.test.ts`
- Test: `tests/messages-handler.test.ts`
- Test: `tests/responses-request-log-prompt-cache-key.test.ts`
- Test: `tests/accounts-manager-free-lb.test.ts`

**Implementation notes:**
- 在 `src/lib/utils.ts` 新增统一 helper，建议返回：
  - `requestId`
  - `affinityKeyUsed`
  - `affinityKeySource`
- key 优先级建议固定为：
  1. `payload.prompt_cache_key`
  2. `metadata.user_id.session_id`
  3. `x-session-id`
  4. `generateRequestIdFromPayload()` fallback
- 三条 handler 在调用 `accountsManager.selectAccountForRequest(...)` 前统一调用该 helper，不再自行拼接 `sessionId ?? upstreamRequestId` 或 `prompt_cache_key ?? upstreamRequestId`。
- **保留现有机制不动：**
  - `src/lib/account-affinity.ts` 的 cache key 结构
  - `src/lib/accounts-manager.ts` 的 `selectAccountForRequest()`
  - `confirmAffinity` 延迟写回模式
  - 现有 round-robin / alias fallback
- `generateRequestIdFromPayload()` 继续保留，但明确只作为最后兜底，不再充当主路径 key。

**Reuse:**
- `parseUserIdMetadata()`
- `getRootSessionId()`
- `generateRequestIdFromPayload()`
- `getUUID()`
- `extractAffinityKey()` / `buildAffinityCacheKey()`

**Verification:**
- `tests/utils.test.ts` 覆盖 helper 的四级优先级与 source 标识。
- `tests/messages-handler.test.ts`、`tests/responses-request-log-prompt-cache-key.test.ts` 验证三条入口使用相同的优先级。
- `tests/accounts-manager-free-lb.test.ts` 确认新增上下文字段不会破坏现有 `confirmAffinity`、cache miss 轮转、disabled affinity 行为。

---

## Phase 3 — request_log observability 落库

### Task 3: 扩展 request_log schema 与 request history 类型

**Files:**
- Modify: `src/lib/admin-db.ts`
- Modify: `src/lib/request-history.ts`
- Modify: `src/lib/accounts-manager.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Test: `src/lib/request-history.test.ts`
- Test: `tests/responses-request-log-prompt-cache-key.test.ts`

**Implementation notes:**
- 在 `src/lib/admin-db.ts` 增加下一版 migration（当前 `user_version = 6`，建议升到 `7`）。
- P0 建议新增列：
  - `affinity_key_used`
  - `affinity_key_source`
  - `selection_reason`
  - `upstream_error_message_raw`
- P1（低成本时顺带做）：
  - `outbound_interaction_id`
  - `outbound_vscode_sessionid_hash`
- 在 `src/lib/request-history.ts` 同步扩展：
  - `RequestLogInsert`
  - `RequestLogRow`
  - insert SQL 与 bind 参数
- 在 `src/lib/accounts-manager.ts` 为成功选择结果增加 `selectionReason`，并在 handler 中与 `affinityHit` / `affinityCacheKey` 一起写入 request log。
- `upstream_error_message_raw` 只保存必要的原始 message；不要落完整 payload，也不要落 raw opaque IDs。

**Verification:**
- `src/lib/request-history.test.ts` 覆盖新增列的 insert/read。
- `tests/responses-request-log-prompt-cache-key.test.ts` 验证 request log 中新增字段已填充。
- 手工检查 SQLite migration 在旧库上是 additive only，不破坏已有数据读取。

---

## Phase 4 — admin API / UI 暴露与回归强化

### Task 4: 先打通 request detail，再决定列表页范围

**Files:**
- Modify: `src/routes/admin-api/route.ts`
- Modify: `admin-ui/src/pages/request-detail-page.tsx`
- Modify: `admin-ui/src/pages/requests-page.tsx`（如需）
- Modify: `src/routes/messages/preprocess.ts`
- Modify: `src/routes/messages/responses-translation.ts`
- Test: `tests/admin-config.test.ts` 或新增 admin request 测试
- Test: `tests/messages-preprocess.test.ts`
- Test: `tests/responses-translation.test.ts`
- Test: `tests/responses-stream-translation.test.ts`

**Implementation notes:**
- 优先把新增 observability 字段暴露到 request detail；列表页筛选/列展示保持最小可用，避免首个观测 PR 过重。
- `tool-only continuation` 与 stateful translation 属于次级风险：先通过回归测试验证是否仍会导致 fallback key 漂移，只有测试证明仍有问题时再做小范围修复。
- 重点复用现有：
  - `stripToolReferenceTurnBoundary()`
  - `mergeToolResultForClaude()`

**Verification:**
- request detail 能看到新增字段。
- 如列表页新增筛选，则验证 source / selection reason / ownership 401 能用于排障。
- `tests/messages-preprocess.test.ts` 确认 tool-only continuation 不会导致 fallback key 意外变化。

---

## Suggested rollout

### PR 1 — 核心修复
- 401 分类
- 统一 affinity key helper
- handler 回归测试

### PR 2 — 观测增强
- `request_log` migration
- request history 类型扩展
- admin API / UI 暴露
- SQLite / admin regression

这样可以把“行为修复”和“观测增强”拆开审查，降低单个 PR 风险。

---

## End-to-end verification checklist

- 先跑 targeted tests，再跑全量：
  - `bun test <targeted files>`
  - `bun test`
  - `bun run typecheck`
  - `bun run lint`
- 如果改了 admin UI，再跑：
  - `bun run build`
- 用同一个 synthetic session / `prompt_cache_key` 连续发多轮请求，确认：
  - 第一轮成功后，后续请求稳定落在同一 `account_id`
  - `affinity_hit = 1` 持续出现
  - `affinity_key_source` / `affinity_key_used` 与预期一致
- 模拟 ownership mismatch 401，确认：
  - 账号不会被误标记 failed
  - request log 能记录原始 upstream error message
- 打开 admin request detail 或直接查 `request_log`，确认新增字段已落库且值合理。

---

## Non-goals / guardrails

- 不引入新的持久化 affinity store。
- 不修改现有 cache TTL / LRU 语义。
- 不落库存量 payload、raw opaque IDs 或其他高敏感度会话内容。
- 如果 Phase 1 已显著消除 401 峰值，后续阶段保持“小修 + 验证”范围，不扩展成新的协议重构项目。
