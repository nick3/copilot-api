# Affinity Miss Premium-Remaining Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在真正的 affinity cache miss 时，按有效 Premium 剩余数最高优先选择上游 Copilot 账号；同值随机；没有明确剩余数时再回退到 unlimited。

**Architecture:** 只调整 affinity miss 的账号遍历顺序，不重写现有通用选择逻辑。通过在 `selectPreferredAffinityAccount()` 返回显式 fallback mode，并新增 `orderAccountsForAffinityMiss()` helper，复用现有模型支持判断、quota reservation、alias fallback 和 `confirmAffinity()` 写回。

**Tech Stack:** TypeScript, Bun test runner, Hono service internals, in-memory account affinity/quota helpers

---

## File Map

- **Modify:** `src/lib/accounts-manager.ts`
  - 在 affinity miss / preferred-account-unavailable 之间引入显式区分
  - 新增 affinity miss 专用的账号排序 helper
  - 在 `selectAccountForRequest()` 中只对真正的 affinity miss 接入新顺序
- **Modify:** `tests/accounts-manager-free-lb.test.ts`
  - 把现有 “cache miss → round-robin” 预期改成 “cache miss → highest effective premium remaining”
  - 增加 tie-break、unlimited 回退、旧 fallback 不扩散的回归测试
- **Reference:** `src/lib/accounts-manager-quota.ts`
  - 复用 `getEffectivePremiumRemaining()`，不重复实现 quota 口径
- **Reference:** `docs/superpowers/specs/2026-04-12-affinity-miss-premium-selection-design.md`
  - 作为本计划的需求边界与测试覆盖依据

---

### Task 1: 先把 affinity miss 的新行为写成失败测试

**Files:**
- Modify: `tests/accounts-manager-free-lb.test.ts:66-619`
- Reference: `src/lib/accounts-manager.ts:1019-1270`

- [ ] **Step 1: 把现有“cache miss 走 round-robin”的测试改成“选 effective premium remaining 最大”**

```ts
test("selectAccountForRequest prefers the account with the highest effective premium remaining on affinity miss", async () => {
  const model = makeModel({
    id: "free-model",
    billing: {
      is_premium: false,
      multiplier: 0,
    },
  })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    premiumRemaining: 12,
    premiumReserved: 4,
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    premiumRemaining: 30,
    premiumReserved: 5,
    models: makeModelsResponse([model]),
  }
  const c: AccountRuntime = {
    id: "c",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_c",
    premiumRemaining: 10,
    premiumReserved: 1,
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b, c])

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-premium-order" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("b")
  expect(selection.selectionReason).toBe("affinity_miss")
})
```

- [ ] **Step 2: 增加同分 tie-break 的失败测试，固定随机结果**

```ts
test("affinity miss randomizes accounts with the same top premium remaining", async () => {
  const model = makeModel({ id: "free-model" })
  const originalRandom = Math.random
  Object.defineProperty(Math, "random", {
    value: () => 0.99,
    configurable: true,
  })

  try {
    const a: AccountRuntime = {
      id: "a",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_a",
      premiumRemaining: 20,
      premiumReserved: 0,
      models: makeModelsResponse([model]),
    }
    const b: AccountRuntime = {
      id: "b",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_b",
      premiumRemaining: 20,
      premiumReserved: 0,
      models: makeModelsResponse([model]),
    }
    const c: AccountRuntime = {
      id: "c",
      accountType: "individual",
      addedAt: Date.now(),
      githubToken: "ghp_c",
      premiumRemaining: 5,
      premiumReserved: 0,
      models: makeModelsResponse([model]),
    }

    const manager = setupManager([a, b, c])
    const selection = await manager.selectAccountForRequest(
      [{ modelId: "free-model", endpoint: "/chat/completions" }],
      { requestId: "session-top-tie" },
    )

    expect(selection.ok).toBe(true)
    if (!selection.ok) return

    expect(["a", "b"]).toContain(selection.account.id)
    expect(selection.account.id).toBe("b")
  } finally {
    Object.defineProperty(Math, "random", {
      value: originalRandom,
      configurable: true,
    })
  }
})
```

- [ ] **Step 3: 增加 `unlimited` 只在没有 scored candidate 时参与前置选择的失败测试**

```ts
test("affinity miss only uses unlimited when no account has an explicit premium remaining score", async () => {
  const model = makeModel({ id: "free-model" })

  const scored: AccountRuntime = {
    id: "scored",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_scored",
    premiumRemaining: 6,
    premiumReserved: 1,
    models: makeModelsResponse([model]),
  }
  const unlimited: AccountRuntime = {
    id: "unlimited",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_unlimited",
    unlimited: true,
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([scored, unlimited])
  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-unlimited-fallback" },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return

  expect(selection.account.id).toBe("scored")
})
```

- [ ] **Step 4: 增加回归测试，证明 `preferred_account_unavailable` 仍保持旧 fallback 语义**

```ts
test("affinity: preferred account unavailable keeps the existing fallback behavior", async () => {
  const model = makeModel({ id: "free-model" })

  const a: AccountRuntime = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([model]),
  }
  const b: AccountRuntime = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    premiumRemaining: 50,
    premiumReserved: 0,
    models: makeModelsResponse([model]),
  }

  const manager = setupManager([a, b])
  const first = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-existing-affinity" },
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.account.id).toBe("a")
  first.confirmAffinity?.()

  a.failed = true
  a.failureReason = "simulated failure"

  const second = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    { requestId: "session-existing-affinity" },
  )
  expect(second.ok).toBe(true)
  if (!second.ok) return

  expect(second.account.id).toBe("b")
  expect(second.selectionReason).toBe("preferred_account_unavailable")
})
```

- [ ] **Step 5: 运行聚焦测试，确认新测试先失败**

Run: `bun test tests/accounts-manager-free-lb.test.ts`
Expected: 新增 affinity miss 相关断言失败，现有 round-robin 逻辑不再满足测试。

---

### Task 2: 在 `AccountsManager` 中接入 affinity miss 的 Premium 剩余数排序

**Files:**
- Modify: `src/lib/accounts-manager.ts:101-142`
- Modify: `src/lib/accounts-manager.ts:1019-1270`
- Reference: `src/lib/accounts-manager-quota.ts:28-37`

- [ ] **Step 1: 为 `selectPreferredAffinityAccount()` 返回值增加显式 fallback mode**

```ts
type PreferredAffinitySelection = {
  result?: SelectAccountForRequestSuccess
  selectionReason: AccountSelectionReason
  fallbackMode: "default" | "affinity_cache_miss" | "preferred_account_unavailable"
}
```

并把方法返回分支改成：

```ts
if (!cacheKey) {
  return {
    selectionReason: initialSelectionReason,
    fallbackMode: "default",
  }
}

const preferredId = this.affinityCache.get(cacheKey)
if (!preferredId) {
  return {
    selectionReason: initialSelectionReason,
    fallbackMode: "affinity_cache_miss",
  }
}

const affinityResult = await this.tryAffinityAccount(
  preferredId,
  orderedAccounts,
  candidates,
)
if (!affinityResult) {
  return {
    selectionReason: preserveSubagentSelectionReason(
      initialSelectionReason,
      "preferred_account_unavailable",
    ),
    fallbackMode: "preferred_account_unavailable",
  }
}
```

- [ ] **Step 2: 新增 affinity miss 专用排序 helper，按有效剩余数分层并在同分组内随机**

```ts
private orderAccountsForAffinityMiss(
  orderedAccounts: Array<AccountRuntime>,
): Array<AccountRuntime> {
  const scored: Array<{ account: AccountRuntime; remaining: number }> = []
  const unlimited: Array<AccountRuntime> = []
  const fallback: Array<AccountRuntime> = []

  for (const account of orderedAccounts) {
    const remaining = getEffectivePremiumRemaining(account)
    if (remaining !== undefined && Number.isFinite(remaining)) {
      scored.push({ account, remaining })
      continue
    }

    if (account.unlimited) {
      unlimited.push(account)
      continue
    }

    fallback.push(account)
  }

  const scoredAccounts = this.shuffleEqualRemainingBuckets(scored)
  if (scoredAccounts.length > 0) {
    return [...scoredAccounts, ...fallback, ...unlimited]
  }

  return [...this.shuffleAccounts(unlimited), ...fallback]
}
```

配套 helper 保持简单：

```ts
private shuffleEqualRemainingBuckets(
  scored: Array<{ account: AccountRuntime; remaining: number }>,
): Array<AccountRuntime> {
  const sorted = [...scored].sort((left, right) => right.remaining - left.remaining)
  const result: Array<AccountRuntime> = []

  for (let index = 0; index < sorted.length; ) {
    const nextIndex = this.findBucketEnd(sorted, index)
    const bucket = sorted.slice(index, nextIndex).map((entry) => entry.account)
    result.push(...this.shuffleAccounts(bucket))
    index = nextIndex
  }

  return result
}
```

- [ ] **Step 3: 只在真正的 affinity miss 时使用新顺序，其他 fallback 保持旧顺序**

在 `selectAccountForRequest()` 里把账号顺序切换写成：

```ts
const accountsForSelection =
  preferredSelection.fallbackMode === "affinity_cache_miss" ?
    this.orderAccountsForAffinityMiss(orderedAccounts)
  : affinityPlan.accountsForSelection

const result = await this.selectWithAliasFallback(
  accountsForSelection,
  candidates,
)
```

并保留现有收尾逻辑：

```ts
return this.finalizeSelectedAccount({
  result,
  cacheKey: affinityPlan.cacheKey,
  selectionReason: preferredSelection.selectionReason,
  ownershipWriteSessionId: context?.ownershipWriteSessionId,
})
```

- [ ] **Step 4: 运行聚焦测试，确认新排序通过**

Run: `bun test tests/accounts-manager-free-lb.test.ts`
Expected: 新增 affinity miss、tie-break、unlimited 和 preferred-account-unavailable 用例全部通过。

---

### Task 3: 做账号选择回归验证，确认没有破坏 reservation / ownership 相关路径

**Files:**
- Test: `tests/accounts-manager-free-lb.test.ts`
- Test: `tests/accounts-manager-reservation.test.ts`
- Reference: `src/lib/accounts-manager.ts:806-906`

- [ ] **Step 1: 运行 accounts-manager 相关回归测试**

Run: `bun test tests/accounts-manager-free-lb.test.ts tests/accounts-manager-reservation.test.ts`
Expected: affinity miss 新行为通过，premium reservation / owner fallback 现有测试不回归。

- [ ] **Step 2: 运行更宽一点的账户相关测试集**

Run: `bun test tests/account-enable-disable.test.ts tests/accounts-manager-free-lb.test.ts tests/accounts-manager-reservation.test.ts`
Expected: 账号启停、free load balancing、reservation 三组测试全部通过。

- [ ] **Step 3: 如聚焦测试通过，再运行一次全量测试确认没有外溢回归**

Run: `bun test`
Expected: 现有测试集通过；若失败，仅接受与当前分支已知无关的历史失败，需单独记录。

---

## Self-Review Checklist

- Spec coverage: 方案 A 的四个核心要求（真正 affinity miss、生效口径、同值随机、unlimited 仅兜底）都在 Task 1/2/3 中有对应实现与验证。
- Placeholder scan: 无 TBD/TODO/“自行处理”等占位语。
- Type consistency: 计划里统一使用 `fallbackMode`, `orderAccountsForAffinityMiss`, `shuffleEqualRemainingBuckets`, `shuffleAccounts` 这组命名；执行时应保持一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-12-affinity-miss-premium-selection.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - 我分任务派发新 subagent 实现并逐段复核
2. **Inline Execution** - 我在当前会话内按计划直接修改并验证

请在执行前二选一。