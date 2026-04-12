# Admin Request Initiator Alignment

## Problem

当前 `/admin#/request/:id` 页面展示的 `initiator` 来自 request history 中保存的 `request_log.initiator`。该值是在 handler 内较早阶段记录的逻辑 initiator，而不是最终实际发送给上游 Copilot API 的 `x-initiator`。

这会在 compact 请求上产生不一致：

- handler 侧可能先把请求判成 `user`
- 但真正构造上游请求头时，`prepareForCompact()` 又会把 `x-initiator` 强制改成 `agent`

结果是：admin 页面显示 `user`，而真实 outbound header 是 `agent`。

---

## Goals

1. 让 **新产生的请求记录** 中的 `initiator` 与真实发送给上游的 `x-initiator` 保持一致。
2. 复用一套共享规则，避免日志与 header 构造再次分叉。
3. 保持现有 admin API 和 admin UI 结构不变。
4. 保持非 compact / 非 subagent 请求的现有行为不变。

## Non-Goals

1. 不回填历史 request log 数据。
2. 不新增数据库字段或迁移。
3. 不修改 admin 页面结构，只修正其展示数据来源的语义。
4. 不改变 compact 或 subagent 的现有上游 header 语义。

---

## Current Behavior Summary

### 1. Admin 页面读取的是 request history

请求详情接口直接从 request history store 读取记录并返回，前端原样展示 `item.initiator`。

### 2. Compact 请求存在“两次决策”

当前链路中，compact 请求会先在 handler 内计算一份逻辑 initiator；随后在上游 header 构造阶段，compact 逻辑又会覆盖 `x-initiator`。

因此当前系统实际存在两个概念：

- `logical initiator`：handler 内较早阶段推断出的值
- `outbound initiator`：最终发给上游的 `x-initiator`

admin 页面今天展示的是前者，但字段命名和用户预期更接近后者。

---

## Design

## Core Rule

引入一个共享 helper，例如：

```ts
resolveEffectiveInitiator(baseInitiator, {
  isCompact,
  isSubagent,
})
```

其职责只有一个：返回**最终 outbound `x-initiator`**。

规则保持与当前上游 header 语义一致：

1. `isCompact === true` → `agent`
2. `isSubagent === true` → `agent`
3. 否则 → `baseInitiator`

---

## Data Flow Changes

### 1. Header 构造改为使用 effective initiator

`createMessages()`、`createChatCompletions()`、`createResponses()` 在构造上游 headers 时，不再各自隐式叠加 compact/subagent 覆盖，而是统一使用 `resolveEffectiveInitiator(...)` 的结果。

这让“最终发给上游的值”有唯一真值来源。

### 2. Request history 改为记录 effective initiator

messages 路径在写入 `instr.initiator` 时，不再保存原始逻辑 initiator，而是保存同一个 `effectiveInitiator`。

这样 `request_log.initiator` 将与真实 outbound header 保持一致，admin 页面无需结构改动即可显示正确结果。

---

## Scope Boundary

本次只修正**新请求**的数据语义。

历史记录由于没有保存：

- 原始 payload 快照
- 真实 outbound header 快照

因此无法可靠回填。旧记录保持现状。

---

## Implementation Plan

### 1. 提取共享 helper

将 effective initiator 规则抽到共享位置，避免 messages / chat completions / responses 三条上游发送路径各自维护一套覆盖逻辑。

### 2. 统一 messages 路径日志记录

在 messages handler 的三条上游分支中，先计算 `effectiveInitiator`，再：

- 赋给 `instr.initiator`
- 传给对应 create 方法

这样 request history 与 outbound header 使用同一个值。

### 3. 统一 create* 路径 header 构造

让 `createMessages()`、`createChatCompletions()`、`createResponses()` 使用同一 helper 生成最终 `x-initiator`，避免未来再次出现“日志一套、header 一套”。

### 4. 补充回归测试

至少覆盖：

- compact 请求：request history 中记录为 `agent`
- 普通用户请求：仍记录为 `user`
- subagent 请求：仍记录为 `agent`

必要时增加一条 handler 级测试，验证 compact 场景下 request detail 所见值与 outbound 规则一致。

---

## Risks and Trade-offs

### 1. 字段语义切换

`request_log.initiator` 从“逻辑 initiator”切换为“最终 outbound initiator”。

这是有意为之，因为当前 admin UI 对该字段的用户预期更接近后者，且本次明确目标就是让页面显示与真实上游 header 一致。

### 2. 历史记录不一致继续存在

旧记录不会自动修复。这是可接受的，因为本次范围明确限定为新请求。

---

## Verification

完成后应验证：

1. 复现 compact 请求，新 request detail 页面显示 `agent`。
2. 非 compact 普通请求仍显示 `user`。
3. subagent 请求仍显示 `agent`。
4. 相关测试通过，且没有改变现有 compact/subagent 上游 header 规则。
