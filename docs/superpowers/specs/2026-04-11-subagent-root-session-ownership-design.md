# Subagent Root Session Ownership for Account Routing

## Problem

`copilot-api` 已经能通过 Claude Code / opencode plugin 注入的 subagent marker 识别 subagent 请求，并从中提取：

```json
{
  "session_id": "<root-session-id>",
  "agent_id": "<subagent-id>",
  "agent_type": "<subagent-type>"
}
```

当前问题不是“能否识别 subagent”，而是：

- subagent 请求虽然带有 root `session_id`
- 但它们不会自动跟随主 agent 会话当前使用的上游 Copilot 账号
- 当 subagent 与主 agent 使用不同模型时，现有 `affinityKey + modelId` 粒度仍可能把它们分流到不同账号

目标是让 **subagent 请求优先路由到其主 agent 会话当前拥有的上游账号**，即使 subagent 使用的模型与主 agent 不同，也不应仅因为 model 不同而优先切换账号。

---

## Goals

1. 当请求被识别为 subagent 且 marker 中含有 root `session_id` 时，优先复用主 agent 会话的上游账号。
2. subagent 跨模型时，不能因为 `modelId` 不同而优先被路由到不同账号。
3. 主 agent 仍保持现有主路径和选路行为，不因为这次需求而被 ownership 逻辑反向控制。
4. owner 不可服务当前请求时，subagent 可以安全回退到现有逻辑。
5. 非 subagent 请求行为保持不变。

## Non-Goals

1. 不新增持久化 ownership store。
2. 不修改 Claude Code / opencode plugin 协议。
3. 不把本次改动扩展成 upstream interaction header / connection header 语义修复。
4. 不改变 `/v1/responses` 或 `/chat/completions` 的无 marker 入口行为。

---

## Current Behavior Summary

### 1. Subagent marker 已可被服务端解析

`/v1/messages` 路径已经可以从首条 user message 中解析 `__SUBAGENT_MARKER__{...}`，并提取 `session_id` / `agent_id` / `agent_type`。

### 2. 现有 account affinity 仍是 model-scoped

当前 affinity cache key 本质上仍是：

```text
<affinity-identity>:<modelId>
```

这意味着即使两个请求属于同一个 root session，只要它们的 model 不同，就会得到不同的 affinity key。

### 3. 只更换 affinity key 来源仍不足以满足需求

如果只是把 subagent marker 里的 `session_id` 接入现有 affinity key 解析，但仍保留 `:<modelId>` 维度，那么：

- 主 agent 用模型 A
- subagent 用模型 B

两者仍会命中不同 key，仍可能走到不同账号。

因此，本次需求不能只靠“更换 affinity key 来源”完成，而需要在现有 affinity 之上增加一层 **session ownership** 语义。

---

## Design

## Core Rule

对这类请求，主约束应该是：

```text
root session -> owning account
```

而不是：

```text
root session + model -> account
```

`modelId` 只应决定：

- 当前 owner 是否有能力服务这次请求
- 如果没有能力，是否需要回退到现有逻辑

它不应成为 subagent 改走其他账号的首要原因。

---

## Ownership Model

新增一个轻量的内存态 ownership cache：

```text
rootSessionId -> accountId
```

### Required properties

- 内存 TTL / LRU 即可，语义与现有 affinity cache 保持同级；默认直接复用 affinity cache 的默认参数：**TTL 1 小时、最大 10,000 条**
- key 不带 model 维度
- value 只保存“当前主会话拥有的账号”
- ownership 允许被后续主 agent 成功请求覆盖
- cache miss / 过期直接按 miss 处理，不做额外补偿

### Why a separate cache instead of reusing affinity key

因为现有 affinity 的职责是“同 identity + 同 model 的局部稳定性”，而本次需求要表达的是“主会话账号所有权”。

这两个约束并不等价：

- affinity 是 model-scoped preference
- ownership 是 session-scoped authority

把 ownership 直接塞进现有 model-scoped key 会让语义混乱，也无法正确支持“subagent 与主 agent 模型不同但账号仍一致”的需求。

---

## Read/Write Boundaries

### Main agent requests

这里的“稳定 root session 身份”指：主 agent 请求虽然没有 subagent marker，但仍能通过当前已经存在的 session-level 信号得到稳定的 root session ID（例如 metadata 中的 session 信息或 `x-session-id` 对应的归一化结果）。只要拿到了这类稳定 session 身份，主请求成功后就有资格写 ownership。

主 agent 请求继续走现有选路逻辑：

- 现有 affinity
- 轮转
- 配额 / quota
- alias fallback

一旦主 agent 请求成功，并且当前请求具有稳定的 root session 身份，就：

- 写入或刷新 `rootSessionId -> accountId` ownership

### Subagent requests

subagent 请求的流程改为：

1. 解析 subagent marker
2. 取出 marker 中的 root `session_id`
3. 以此查询 ownership cache
4. 如果命中 owner，优先尝试该账号
5. 如果 owner 当前不可服务，再回退到现有逻辑

### Important constraint

**subagent 请求成功后不写 ownership。**

这是本设计最关键的边界之一。

原因：

- ownership 的语义是“主会话当前拥有的账号”
- 不是“最近一次 subagent 成功落到的账号”

如果允许 subagent 抢跑并反写 ownership，那么：

- 主 agent 还没建立 ownership 时
- 一个 subagent 先按 fallback 逻辑命中某账号
- 它会把这个账号错误地宣告为 root session owner

这会把“子请求临时自救”放大成“主会话 owner 被改写”，不符合需求。

因此：

- **主 agent 负责写 ownership**
- **subagent 只读取 ownership**

---

## Selection Order

对于 subagent 请求，建议的账号选择顺序为：

1. **Subagent ownership lookup**
   - 用 marker 中的 root `session_id` 查 ownership cache
2. **If owner hit and usable**
   - 直接走 owner 账号
3. **If owner hit but unusable**
   - 记录 owner fallback reason
   - 回退到现有逻辑
4. **If owner miss**
   - 直接回退到现有逻辑

回退后的“现有逻辑”保持当前定义：

- 现有 affinity
- 轮转
- quota 检查
- alias fallback

这样就能满足用户已确认的边界：

- subagent 若能跟随主 agent owner，就必须跟随
- owner 不可服务时，不要硬失败，按当前逻辑继续兜底
- subagent 抢跑时允许暂时 fallback，但不污染 owner

---

## Behavior Matrix

### Case A — Main agent first, subagent later, different model

- 主 agent 成功后写 ownership
- subagent 查询到 owner
- 即使模型不同，仍优先走同一账号
- 只有 owner 无法服务该模型时才 fallback

### Case B — Subagent first, ownership not established yet

- subagent 查 ownership miss
- 按现有逻辑选择账号
- 本次 subagent 成功不写 ownership
- 后续主 agent 成功后建立 ownership
- 之后的 subagent 再开始稳定跟随

### Case C — Owner hit but owner unsupported / failed / quota-blocked

- subagent 查询到 owner
- 发现 owner 当前不可服务
- 记录原因
- 回退现有逻辑
- 不把 fallback 成功结果写成新的 ownership

### Case D — Main agent later moves to another account successfully

- 主 agent 成功请求覆盖旧 ownership
- 后续 subagent 自动跟随新的 owner

---

## Observability

现有 `is_subagent`、`affinity_key_used`、`affinity_key_source`、`affinity_hit`、`affinity_cache_key` 还不够完整表达这次新规则。

建议新增或明确补充以下 selection / routing reason 语义：

- `subagent_owner_hit`
- `subagent_owner_miss`
- `subagent_owner_unusable_fallback`
- `subagent_marker_invalid_fallback`
- `main_session_owner_write`
- `main_session_owner_overwrite`

这些信号至少应能在 request log 或等价的调试日志里看见，方便回答：

- 这次 subagent 有没有查到主会话 owner
- 查到了为什么没用上
- 是 marker 坏了，还是 owner 不支持模型，还是 quota / failed 导致 fallback
- 主 agent 是否真的完成了 ownership 建立或覆盖

本次设计不要求立即把所有字段暴露到 admin UI，但至少应保证底层有足够可追踪的结构化信息。

---

## Error Handling

### Invalid marker

如果 subagent marker 不存在、解析失败、或缺少 root `session_id`：

- 按普通请求处理
- 不抛新错误
- 不写 ownership
- 允许记录 `subagent_marker_invalid_fallback`

### Expired or missing ownership

ownership cache miss / TTL 过期：

- 直接视为 miss
- 按当前逻辑继续
- 不做阻塞式补偿

### Owner unusable

owner 命中但账号当前不可服务（例如模型不支持、账号临时 failed、或 quota 不允许）：

- 记录 unusable fallback reason
- 回退当前逻辑
- subagent 成功后不写 ownership

### Main agent overwriting owner

主 agent 后续若在另一个账号上成功：

- 新成功结果覆盖旧 ownership
- 不需要额外冲突协调

因为 ownership 的定义本来就是“主会话当前拥有的账号”，而不是“历史上第一次命中的账号”。

### Concurrent main-agent writes

如果同一个 root session 下有两个主 agent 成功请求并发完成，ownership 采用 **last-write-wins**。

这在本设计里是可接受的，因为：

- 只有主 agent 成功请求才能写 ownership
- 两次写入都指向“真实成功过”的账号，而不是失败或猜测值
- 更晚完成的主请求更接近当前活跃会话实际落到的账号
- subagent 的目标本来就是跟随“当前主会话 owner”，而不是守住最早写入者

---

## Scope of Code Changes

这次设计建议控制在以下层次：

### New component

新增一个轻量 session ownership 模块，职责只有两件事：

1. `get(rootSessionId) -> accountId | undefined`
2. `set(rootSessionId, accountId)`

可复用现有 affinity cache 的 TTL / LRU 思路，但语义保持独立。

### Integration points

1. `/v1/messages` handler
   - 继续解析 subagent marker
   - 对 subagent 请求传递 root session ownership lookup 所需上下文
   - 对主 agent 成功请求执行 ownership write

2. `accounts-manager`
   - 在现有选账号流程前插入 subagent owner lookup
   - owner 不可服务时回退现有逻辑
   - 保持现有 affinity 行为不变

3. tests
   - 增加跨模型 subagent 跟随主 agent owner 的回归用例
   - 增加 subagent 抢跑不反写 owner 的回归用例
   - 增加 owner 不可服务 fallback 的回归用例

### Explicitly out of scope

- plugin payload 结构变更
- admin UI 新功能
- 改造全部 handler 为统一 ownership 入口
- 引入持久化 ownership 数据结构

---

## Test Plan

### Must-pass scenarios

1. **Main agent seeds ownership; subagent follows across model**
   - 主 agent 成功建立 owner
   - subagent 使用不同模型
   - subagent 仍走主 agent 账号

2. **Subagent arrives before owner exists**
   - ownership miss
   - subagent 回退当前逻辑
   - subagent success 不写 owner
   - 主 agent 后续成功后写 owner
   - 之后 subagent 才稳定跟随

3. **Owner unsupported model**
   - ownership hit
   - owner 不支持 subagent 模型
   - 记录 unusable fallback
   - 回退当前逻辑

4. **Owner temporarily failed / quota-blocked**
   - ownership hit
   - owner 当前不可服务
   - 回退当前逻辑
   - 不反写 owner

5. **Invalid subagent marker**
   - 行为与今天一致
   - 只多出可观测 fallback reason

6. **Non-subagent request unchanged**
   - 所有现有测试语义保持成立

### Acceptance criteria

1. subagent 跨模型时，不再因为 model 不同而优先换账号。
2. ownership 只由主 agent 成功写入。
3. subagent 抢跑不会污染主会话 owner。
4. owner 不可用时，服务仍能按当前逻辑继续工作。
5. 非 subagent 行为没有回归。
6. 排查时能明确区分 owner hit / miss / unusable / invalid-marker。

---

## Trade-offs

### Why this design is worth it

- 精准满足“subagent 跟随主 agent 账号”这个需求
- 不要求推翻现有 affinity 体系
- 不引入持久化和大范围迁移
- 对失败路径保持保守，风险可控

### Cost accepted by this design

- 新增一层 session ownership 概念，系统语义从“纯 affinity”变成“ownership + affinity”两层
- subagent 抢跑场景不会立刻稳定，需要等主 agent 成功后才真正建立 owner
- 需要补一组新的可观测 reason，避免线上排查时混淆 ownership fallback 与普通 affinity miss

这些成本是可接受的，因为它们正好对应用户明确要的行为边界。

---

## Final Recommendation

采用 **subagent-only ownership lookup + main-agent ownership write** 的方案：

- 主 agent 继续按现有逻辑选路，但成功后写 `rootSessionId -> accountId`
- subagent 请求优先查 root session owner
- 命中则优先跟随主 agent 账号，即使 model 不同
- owner 不可服务则回退到当前逻辑
- subagent 自己永远不反写 ownership

这是在当前代码结构下，最小、最稳定、也最符合真实业务语义的方案。
