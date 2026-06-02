# 账号亲和性 / Connection Ownership 问题分析（2026-04-11）

## 背景

当前 `copilot-api` 通过账号亲和性（account affinity）尝试把同一个下游 Agent 会话的后续请求路由到同一个上游 Copilot 账号，避免上游因为会话状态不一致而拒绝请求。

已观察到的上游报错包括：

```text
status_code=401, {"error":{"message":"input item ID does not belong to this connection","code":""}}
```

以及同类变体：

```text
status_code=401, {"error":{"message":"input item does not belong to this connection","code":""}}
```

本次文档的目标是整理：

- 当前问题现象
- 已确认的结论
- 最可能的原因排序
- 采用过的排查方法
- 生产数据库样本证据
- 当前仓库中仍需继续关注的风险点
- 后续建议补充的日志字段

---

## 执行摘要

### 已确认结论

1. **上游并不是在“猜这个请求像不像同一个会话”**，而是在校验当前请求中回传的 opaque item IDs 是否属于当前 upstream connection / session namespace。
2. **本次生产样本中的主因已经可以定性为跨账号误路由**：同一个 `prompt_cache_key` 的稳定成功流量长期落在固定账号上，而 401 段落会突然落到一组其他账号上；随后一旦回到原本拥有该会话状态的账号，又立刻恢复 200。
3. **“同账号但 session header 轮换”是次级风险，不是这批样本的主因**。原因是拥有该会话的账号在样本中持续成功，而 401 主要出现在其他账号上。
4. **当前仓库代码与生产样本表现并不完全一致**：仓库中 `/responses` 路径当前看起来优先使用 session-level key，但生产数据库样本显示同一个 `prompt_cache_key` 在一段时间里实际对应了多个不同的 `affinity_cache_key`，说明生产流量当时至少部分仍在使用 message-level affinity key。

### 一句话总结

**对当前问题最准确的描述是：同一个会话携带了上游生成的 stateful item IDs，但某些请求被路由到了不拥有这些 IDs 的上游账号，于是上游返回 `does not belong to this connection`。**

---

## 我们是如何排查的

本次分析采用了三条证据链并行交叉验证：

### 1. 静态代码排查

重点检查了：

- 账号亲和性 key 的生成、命中与写回逻辑
- `/v1/messages`、`/v1/responses`、`/chat/completions` 三条路径的选账号逻辑
- Anthropic ↔ Responses 翻译层里是否会把上游生成的 opaque IDs 带回上游
- 上游请求 headers 中哪些字段可能影响 connection / session 归属

### 2. 协议 / 外部语义旁证

参考了公开的 Responses API 语义与公开 issue，确认这一类 API 并不是完全无状态的纯文本接口，而是存在服务端维护的会话 / item 状态容器。外部旁证包括：

- OpenAI Responses conversation-state 文档（`previous_response_id` / conversation state）
- `github/copilot-cli#2147` 中同类 “does not belong to this connection” 错误

### 3. 生产数据库样本分析

用户提供了生产环境数据目录副本中的数据库：

- `copilot-data/admin.sqlite`

我们在 `request_log` 中重点检查：

- 相同 `prompt_cache_key` 是否跨多个账号出现
- 401 前后的 `account_id` / `affinity_hit` / `affinity_cache_key` 模式
- 是否存在“若干错误账号 401 -> 原账号恢复 200”的时间线
- 同一 `prompt_cache_key` 是否对应多个不同的 `affinity_cache_key`

---

## 关键代码证据

### 1. 代理会把上游生成的 opaque IDs 回传给上游

这说明问题不是纯文本上下文，而是**服务端拥有权（ownership）**问题。

### `reasoning.id` 会被回传

- 将 Anthropic thinking block 转成 Responses `reasoning` input item：`src/routes/messages/responses-translation.ts:354`
- 将上游返回的 `reasoning.id` 再编码回 Anthropic `thinking.signature`：`src/routes/messages/responses-translation.ts:517`

### `compaction.id` 会被回传

- 将 Anthropic compaction signature 转成 Responses `compaction` input item：`src/routes/messages/responses-translation.ts:370`
- 将上游返回的 `compaction.id` 编码回 `thinking.signature`：`src/routes/messages/responses-translation.ts:642`

### `function_call.call_id` / `function_call_output.call_id` 会被回传

- 将 tool use 转成 `function_call`：`src/routes/messages/responses-translation.ts:400`
- 将 tool result 转成 `function_call_output`：`src/routes/messages/responses-translation.ts:410`

**结论：** 后续请求中携带的并不是纯文本，而是上一轮上游生成的 opaque IDs。只要这些请求被发到错误的上游账号 / connection，就很容易触发 ownership 校验失败。

---

## 2. 当前仓库中的账号亲和性 key 逻辑

### `/v1/messages`

- root session 提取：`src/lib/utils.ts:214`
- fallback request id 生成：`src/lib/utils.ts:195`
- 选账号时使用 `sessionId ?? upstreamRequestId`：`src/routes/messages/handler.ts:252`

这意味着：

- 如果拿到了稳定 `sessionId`，亲和性有机会稳定
- 如果没拿到稳定 `sessionId`，就会退化成基于当前消息内容的 request key

### `/v1/responses`

当前仓库中：

- 解析 `prompt_cache_key` / metadata session：`src/routes/responses/handler.ts:71`
- 选账号时使用 `normalizedPromptCacheKey ?? upstreamRequestId`：`src/routes/responses/handler.ts:102`、`src/routes/responses/handler.ts:115`

从代码看，这条路径已经偏向 session-level affinity。

---

## 3. 上游 headers 中存在两类 session / connection 语义

- `x-interaction-id`：`src/lib/api-config.ts:121`
- `vscode-sessionid`：`src/lib/api-config.ts:269`、`src/lib/api-config.ts:293`

这意味着，上游很可能不只是看 token，还会看 interaction / client session 相关标识。

不过对于本次生产样本来说，**主要证据仍然指向跨账号误路由，而不是同账号 session header 轮换**。

---

## 4. 当前代码会把这类 401 当成账号失败处理

- `src/routes/messages/handler.ts:848`

这里一旦识别为 unauthorized，就会调用 `markAccountFailed(...)`。

如果这个 401 的真正含义其实是“会话归属错误”，而不是“账号失效 / token 失效”，那它会放大问题：

- 错误账号被标记 failed
- 后续选路继续偏离真实拥有该会话的账号
- 排查时也会把“账号坏了”和“会话发错账号了”混在一起

---

## 生产数据库样本证据

数据库文件：

- `copilot-data/admin.sqlite`

表结构中已有与本问题强相关的字段：

- `prompt_cache_key`
- `upstream_request_id`
- `affinity_hit`
- `affinity_cache_key`
- `account_id`
- `upstream_endpoint`
- `client_model`
- `upstream_model`

---

## 样本 A：`prompt_cache_key = 019d7628-b1a8-7dc2-8f02-64c7c9ed976b`

### 统计结果

- 总记录数：130
- 涉及账号数：6
- 401 数量：71

按账号分组后：

- `nick3github`: `59 x 200`, `0 x 401`
- `luolamiss`: 多次 `401`
- `394104597`: 多次 `401`
- `whtthd-dev`: 多次 `401`
- `nick3vipqq`: 多次 `401`
- `ruthsparker7586`: 多次 `401`

### 最关键的时间线模式

以下模式反复出现：

1. `nick3github` 连续成功，并且 `affinity_hit = 1`
2. 突然同一个 `prompt_cache_key` 被发到其他 5 个账号，连续返回 `401`
3. 随后又回到 `nick3github`，立刻恢复 `200`
4. 下一个成功请求重新建立新的 affinity key，继续稳定一段时间

一个典型片段：

- `1892` ~ `1896`: `nick3github`, `200`, `affinity_hit = 1`
- `1897` ~ `1901`: 其他 5 个账号，全部 `401`
- `1902`: `nick3github`, `200`
- `1903`: `nick3github`, `200`, `affinity_hit = 1`

后续 `1924` ~ `1930`、`1933` ~ `1939`、`1942` ~ `1954` 也重复出现这个模式。

### 这个样本说明了什么

这已经足以排除“上游随机抽风”这一类解释。更合理的解释是：

- 正确拥有该会话状态的账号是 `nick3github`
- 某些请求丢失了原本稳定的 affinity 绑定
- 这些请求被发到了其他账号
- 这些账号没有当前会话对应的 item ownership，于是 401
- 请求回到 `nick3github` 后立即恢复成功

---

## 样本 B：`prompt_cache_key = 40d4ab52-e643-4cc6-b58e-3ac12f61d534`

### 统计结果

- 总记录数：220
- 涉及账号数：17
- 401 数量：26

按账号分组后：

- `nick3github`: `183 x 200`, `0 x 401`
- `lordofriver`: `11 x 200`, `1 x 401`
- 其他多个账号：仅出现 `401`

### 这个样本的意义

这个样本比样本 A 更复杂，但总体模式一致：

- 大部分成功流量仍然集中在少数“真正拥有会话状态”的账号
- 错误流量会瞬间分散到许多从未成功拥有该会话状态的账号上

这与“跨账号误路由”高度一致。

---

## 一个额外的关键发现：同一个 `prompt_cache_key` 对应了多个 `affinity_cache_key`

### 样本 A

对 `019d...` 这个会话，`affinity_hit = 1` 的成功记录里，出现了 **11 个不同的 `affinity_cache_key`**。

其中包括：

- `fd637e17-...:copilot/gpt-5.4-mini`
- `33b108e2-...:copilot/gpt-5.4-mini`
- `daf146cd-...:copilot/gpt-5.4-mini`
- `6f13b1b6-...:copilot/gpt-5.4-mini`
- `1ed45374-...:copilot/gpt-5.4-mini`

而不是始终稳定地等于：

- `019d7628-b1a8-7dc2-8f02-64c7c9ed976b:copilot/gpt-5.4-mini`

### 这意味着什么

这说明生产流量在这一阶段**并没有稳定使用 `prompt_cache_key` 作为 affinity key**。

更像是：

- 会话先在某个 message-level key 下稳定一小段时间
- 当用户新发一轮消息后，key 变化
- affinity 失手
- 该轮请求被轮流发往其他账号并触发 401
- 最终回到真正拥有状态的账号成功
- 然后在这个“新的 message-level key”下又稳定一段时间

这是本次分析中最强的生产侧证据之一。

---

## 假设排序

### 假设 1：跨账号误路由（已被生产样本强支持）

**结论：最可能，且对当前样本基本已确认。**

证据：

- 同一 `prompt_cache_key` 长时间稳定成功于固定账号
- 401 集中出现在其他账号上
- 拥有该会话的账号在对应样本中 `0 x 401`
- 错误段前后会恢复到原账号并恢复成功

---

### 假设 2：同账号但 session / connection header 变化

**结论：是合理风险，但不是本批样本的主因。**

证据：

- 当前代码里上游 headers 确实包含 `x-interaction-id` 与 `vscode-sessionid`：`src/lib/api-config.ts:121`、`src/lib/api-config.ts:269`
- `clientSessionId` 会被定时刷新：`src/lib/accounts-manager.ts:237`、`src/lib/accounts-manager.ts:477`

但反证同样很强：

- 在当前生产样本里，真正拥有该会话的账号没有出现对应 401
- 401 主要出现在其他账号上

所以它更像是**后续需要保留观察的次级风险**。

---

### 假设 3：上游只是基于文本 / 普通 session string 做模糊判断

**结论：不支持。**

因为当前请求中回传的是上游生成的 opaque IDs，而不是单纯文本上下文。

---

## 为什么这个问题“只在少数时候出现”

因为不是每一轮都满足触发条件。

通常需要同时满足：

1. 当前轮请求包含上游生成的 stateful item IDs（reasoning / compaction / function_call 等）
2. 当前轮的 affinity key 没有延续上一个稳定 session key
3. 请求被发到了错误账号

所以它会表现成：

- 大多数时候正常
- 少数时候某一轮突然错到别的账号上，连续报 401
- 最后回到真正拥有该会话的账号后恢复正常

---

## 当前仓库中仍值得继续关注的风险点

### 1. `/v1/messages` 路径仍可能退化成 `upstreamRequestId`

- root session 提取：`src/lib/utils.ts:214`
- fallback request id：`src/lib/utils.ts:195`
- 选账号：`src/routes/messages/handler.ts:252`

如果某些请求没有稳定 `sessionId`，依然可能走到 message-level key。

### 2. tool-only continuation 可能让 fallback key 不稳定

- `stripToolReferenceTurnBoundary(...)`：`src/routes/messages/preprocess.ts:130`
- `mergeToolResultForClaude(...)`：`src/routes/messages/preprocess.ts:149`
- `findLastUserContent(...)`：`src/lib/utils.ts:174`

某些 continuation 请求如果最终无法提取稳定的 last user content，就可能导致 request key 退化。

### 3. 401 被统一当作账号失效会放大问题

- `src/routes/messages/handler.ts:848`

建议后续把“item ownership 401”与“token unauthorized 401”区分处理。

---

## 是否需要在数据库中记录更多日志信息？

**需要，但不需要大而全。**

目标不是把 payload 全部落库，而是补上当前恰好缺失、且能直接区分根因的几项。

### P0：建议长期保留

#### `affinity_key_used`

实际用于本轮 `selectAccountForRequest()` 的原始 affinity key。

#### `affinity_key_source`

记录 key 来源：

- `payload.prompt_cache_key`
- `metadata.user_id.session_id`
- `x-session-id`
- `upstream_request_id_fallback`

#### `selection_reason`

记录为何选中该账号：

- `affinity_hit`
- `affinity_miss`
- `preferred_account_unavailable`
- `no_session_key`
- `model_dimension_change`
- `rotated_after_miss`

#### `upstream_error_message_raw`

记录上游原始错误体 message / code，而不是仅记录 `Failed to create responses`。

### P1：建议轻量补充

#### `outbound_interaction_id`

本轮真正发往上游的 `x-interaction-id`。

#### `outbound_vscode_sessionid_hash`

本轮 `vscode-sessionid` 的 hash 或截断值，用于判断它是否变化。

#### `stateful_input_summary`

建议做成小 JSON，记录：

- `reasoning_count`
- `compaction_count`
- `function_call_output_count`
- `first_reasoning_id_hash`
- `first_compaction_id_hash`

#### `attempt_group_id` / `attempt_index`

用于把“同一次下游请求导致的一串尝试”结构化串起来。

### 不建议长期落库

- 完整请求 / 响应 payload
- 完整 opaque item IDs 原文

建议用 hash 或截断值替代，满足排查即可。

---

## 我们实际使用过的 SQL 排查方式

### 1. 查某类 401 样本

```sql
SELECT
  id,
  datetime(started_at_ms/1000,'unixepoch','localtime') AS started_local,
  upstream_endpoint,
  http_status,
  error_status,
  prompt_cache_key,
  affinity_hit,
  affinity_cache_key,
  account_id
FROM request_log
WHERE http_status = 401 OR error_status = 401
ORDER BY id DESC;
```

### 2. 对单个 `prompt_cache_key` 做时间线分析

```sql
SELECT
  id,
  datetime(started_at_ms/1000,'unixepoch','localtime') AS started_local,
  account_id,
  affinity_hit,
  affinity_cache_key,
  http_status,
  error_status
FROM request_log
WHERE prompt_cache_key = '019d7628-b1a8-7dc2-8f02-64c7c9ed976b'
ORDER BY id ASC;
```

### 3. 看同一个会话是否跨多个账号

```sql
SELECT
  prompt_cache_key,
  COUNT(*) AS total,
  COUNT(DISTINCT account_id) AS distinct_accounts,
  SUM(CASE WHEN http_status = 401 OR error_status = 401 THEN 1 ELSE 0 END) AS unauthorized_count
FROM request_log
WHERE prompt_cache_key IN (
  '019d7628-b1a8-7dc2-8f02-64c7c9ed976b',
  '40d4ab52-e643-4cc6-b58e-3ac12f61d534'
)
GROUP BY prompt_cache_key;
```

### 4. 看同一个会话是否出现多个 affinity keys

```sql
SELECT
  prompt_cache_key,
  COUNT(DISTINCT affinity_cache_key) AS distinct_affinity_keys
FROM request_log
WHERE prompt_cache_key = '019d7628-b1a8-7dc2-8f02-64c7c9ed976b'
  AND affinity_hit = 1
GROUP BY prompt_cache_key;
```

---

## 后续工作建议

如果下一步进入修复或实现排查增强，建议优先顺序如下：

1. **统一并固定所有 stateful 路径的 session-level affinity key**
2. **区分“item ownership 401”与“账号 unauthorized 401”**，避免误标记 healthy account failed
3. **补最小量但高价值的 observability 字段**：`affinity_key_used`、`affinity_key_source`、`outbound_interaction_id`、`upstream_error_message_raw`
4. **再处理次级风险**：同账号 session header 轮换、tool-only continuation fallback 等

---

## 当前文档适用范围

本文件适合作为：

- 后续修复设计前的背景材料
- 继续扩展日志字段前的依据整理
- 验证生产环境是否仍存在 message-level affinity 退化的参考
- 新加入该问题排查的协作者的快速上下文

如果后续修复方案落地，建议基于本文件再补一份单独的 implementation / design 文档，避免把“已确认事实”和“计划修改方案”混在一起。
