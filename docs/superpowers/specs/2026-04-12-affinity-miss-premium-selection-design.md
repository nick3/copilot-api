# Affinity Miss Premium-Remaining Selection

## Problem

当前 `accountAffinity` 启用后，请求如果没有通过 affinity cache key 命中已绑定的上游账号，会回退到基于 `loadBalanceCursor` 的轮转顺序。这个策略能分散请求，但它并不关心各上游账号当前剩余的 Premium 请求数。

本次需求要求把“真正的 affinity cache miss”回退逻辑改成：

- 优先选择 **有效 Premium 剩余数最多** 的账号
- 如果多个账号剩余数相同，则在这些账号中 **随机** 选择
- 当不存在带有明确剩余数的候选账号时，才回退到 `unlimited` 账号

这里的“有效剩余数”定义为：

```text
premiumRemaining - premiumReserved
```

也就是复用当前并发安全的 quota 视图，而不是只看原始快照值。

---

## Goals

1. 仅在 **真正的 affinity cache miss** 时启用新的账号排序规则。
2. 候选账号中存在明确 `effectivePremiumRemaining` 时，优先选择剩余数最大的账号。
3. 相同剩余数的账号之间引入随机打散，避免固定偏向。
4. 没有明确剩余数候选时，才回退到 `unlimited` 账号。
5. 继续复用现有模型支持判断、quota reservation、alias fallback、overage fallback 和 `confirmAffinity()` 行为。
6. 尽量缩小改动面，避免把新规则扩散到用户未指定的 fallback 路径。

## Non-Goals

1. 不改变 affinity cache key 的组成方式。
2. 不修改 `preferred_account_unavailable` 的回退行为。
3. 不把新规则扩展到 owner fallback 或无 affinity context 的普通轮转路径。
4. 不新增持久化状态。

---

## Current Behavior Summary

### 1. 真正命中 affinity cache 时优先走绑定账号

当前逻辑会先基于 `affinityKey + modelId` 生成 `cacheKey`，然后尝试从 affinity cache 中取出已绑定账号。若命中且该账号可服务当前请求，就直接返回。

### 2. 未命中时使用轮转顺序

如果 affinity cache 没有绑定账号，当前实现会构造一个基于 `loadBalanceCursor` 旋转后的账号列表，再交给通用选择逻辑按“第一个可用账号”进行选择。

### 3. 可用性判断已包含完整 quota 逻辑

现有通用选择逻辑已经处理：

- 模型/endpoint 是否支持
- 失败账号跳过
- Premium quota 刷新与 reservation
- `unlimited` 账号
- overage fallback
- alias fallback

因此本次改动最适合落在“**如何给出账号遍历顺序**”这一层，而不是重写整套选择逻辑。

---

## Design

## Core Rule

对于 **affinity cache miss**，候选账号顺序改为三层：

1. **Scored accounts**：有明确 `effectivePremiumRemaining` 的账号，按剩余数降序排列
2. **Unlimited accounts**：仅在第 1 层为空时启用，在该集合内随机打散
3. **Fallback accounts**：其他没有明确剩余数、且不是 `unlimited` 的账号，保持原顺序兜底

同分账号的随机只发生在各自层内，不改变层级间优先级。

---

## Scope Boundary

新规则只应用在以下场景：

```text
cacheKey 已存在
&& affinity cache 中没有 preferred account
```

也就是“真正的 affinity cache miss”。

以下场景保持现状：

- `preferred_account_unavailable`
- `subagent_owner_miss`
- `subagent_owner_unusable_fallback`
- `no_session_key`
- affinity disabled

这样可以确保本次需求只覆盖用户明确点名的路径，而不是顺带重写整套 fallback 语义。

---

## Implementation Plan

### 1. 在 `selectPreferredAffinityAccount()` 中返回显式 miss 类型

当前该方法只返回：

- `result`
- `selectionReason`

这不足以在调用方区分：

- `cacheKey` 不存在
- affinity cache 真 miss
- preferred account 存在但不可用

因此需要增加一个显式状态，例如：

```ts
fallbackMode: "default" | "affinity_cache_miss" | "preferred_account_unavailable"
```

调用方据此决定是否启用新的 premium-remaining 排序，而不是依赖 `selectionReason` 文本推断。

### 2. 新增 `orderAccountsForAffinityMiss()` 私有 helper

输入：

- `orderedAccounts`

输出：

- 一个新的账号数组，用于后续通用选择逻辑遍历

排序规则：

#### Step A — 计算得分

对每个 enabled account：

- 若 `getEffectivePremiumRemaining(account)` 是有限数字，则归入 scored accounts
- 若没有明确剩余数且 `account.unlimited === true`，归入 unlimited accounts
- 其他账号归入 fallback accounts

#### Step B — scored accounts 排序

- 按 `effectivePremiumRemaining` 降序
- 对相同剩余数的连续分组做随机打散

#### Step C — unlimited accounts 处理

- 仅当 scored accounts 为空时才参与前置
- 在 unlimited 组内随机打散

#### Step D — fallback accounts 处理

- 保持原顺序
- 永远排在前两层之后，作为最终兜底

### 3. 在 `selectAccountForRequest()` 中接入新顺序

流程改为：

1. 生成 affinity plan
2. 尝试 preferred affinity account
3. 若 preferred 命中，直接返回
4. 若 `fallbackMode === "affinity_cache_miss"`，使用 `orderAccountsForAffinityMiss()` 生成账号顺序
5. 其他情况继续使用现有 `affinityPlan.accountsForSelection`
6. 仍然交给 `selectWithAliasFallback()` 完成最终选择
7. 仍然走 `finalizeSelectedAccount()` 维护 cursor、selection reason 和 `confirmAffinity`

这样做的好处是：

- 新规则只影响“顺序”，不重写“可用性判断”
- 现有 reservation / alias / overage 逻辑全部保留
- 风险比直接重写 `selectAccountForCandidates()` 更低

---

## Random Tie-Break Strategy

随机只需要满足“避免固定偏向”，不需要引入复杂随机源。

推荐做法：

- 对相同剩余数的数组分组
- 对每个分组做 Fisher-Yates shuffle，使用 `Math.random()`

这样可以保持：

- 不同剩余数之间仍然严格按高到低优先
- 同分组内没有固定顺序偏向

测试时可以通过临时替换 `Math.random()` 来固定结果。

---

## Behavior Matrix

### Case A — 有明确剩余数候选

- A: 20
- B: 8
- C: 3

结果：A 优先，之后才是 B、C。

### Case B — 最高剩余数并列

- A: 20
- B: 20
- C: 5

结果：A/B 先组成同分组并随机打散，C 固定在后。

### Case C — 没有明确剩余数，但有 unlimited

- A: `premiumRemaining` 未知
- B: `premiumRemaining` 未知 + `unlimited`
- C: `premiumRemaining` 未知 + `unlimited`

结果：B/C 先在 unlimited 组内随机打散，A 在后面兜底。

### Case D — cache hit 但 preferred 不可用

结果：保持当前 fallback，不自动改用新的 premium-remaining 排序。

---

## Testing Plan

在 `tests/accounts-manager-free-lb.test.ts` 中补充或调整以下用例：

1. **Affinity miss prefers account with highest effective premium remaining**
   - 构造多个支持同一模型的账号
   - 设置不同 `premiumRemaining` / `premiumReserved`
   - 断言未命中时选择有效剩余数最大的账号

2. **Affinity miss randomizes ties within the top remaining bucket**
   - 构造两个相同最高剩余数的账号
   - 固定 `Math.random()`
   - 断言 tie-break 结果可预测

3. **Unlimited is only used when no scored candidate exists**
   - 同时存在 scored accounts 和 unlimited accounts 时，应优先 scored accounts
   - 只有没有 scored accounts 时，才让 unlimited 参与前置选择

4. **Preferred account unavailable keeps old fallback semantics**
   - 证明这次需求没有把行为误扩散到 `preferred_account_unavailable`

如有必要，还可以增加一条用例验证：

5. **Fallback accounts preserve original order when neither scored nor unlimited is available**

---

## Risks and Mitigations

### Risk 1 — 误把新规则扩散到非 affinity miss 路径

**Mitigation:**
用显式 `fallbackMode` 区分“真正 miss”和“账号不可用 fallback”，不要用 `selectionReason` 文本做推断。

### Risk 2 — 同分随机导致测试不稳定

**Mitigation:**
测试中固定 `Math.random()`，并把随机范围限制在同分组内部。

### Risk 3 — 重写通用选择逻辑带来 quota 回归

**Mitigation:**
只改账号顺序，不改 `selectAccountForCandidates()` 的 quota/reservation 逻辑。

---

## Summary

推荐实现方式是：

- **只在真正 affinity cache miss 时**
- 基于 `getEffectivePremiumRemaining()` 构造账号优先级
- 相同剩余数随机打散
- 没有明确剩余数时再回退到 `unlimited`
- 最终仍复用现有通用选择逻辑完成模型支持、quota reservation、alias fallback 和成功后 affinity 写回

这满足用户要求，同时把行为变化严格限制在指定路径内。