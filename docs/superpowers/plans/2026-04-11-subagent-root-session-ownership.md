# Subagent Root Session Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/v1/messages` 的 subagent 请求优先跟随主 agent 会话当前拥有的上游 Copilot 账号，即使 subagent 使用不同模型，也不会仅因为 `modelId` 不同而优先切换账号；owner 不可服务时再安全回退到现有逻辑。

**Architecture:** 保留现有 model-scoped `account-affinity` 作为次级机制，在其前面增加一个只供 subagent 读取的 session ownership 层：主 agent 成功后按 root session 写入 `rootSessionId -> accountId`，subagent 请求优先按 marker 中的 root `session_id` 读取 owner。subagent 自己永远不反写 ownership；invalid marker、owner miss、owner unusable 都退回当前选路路径，并通过 `selectionReason` 暴露可观测原因。

**Tech Stack:** TypeScript、Hono、Bun test、现有 in-memory TTL/LRU cache、`accounts-manager`、`request-history`

**Git note:** 本计划故意省略 commit 步骤。只有在用户明确要求时才创建 git commit。

---

## File map

### New files
- `src/lib/session-ownership.ts` — 独立的 root-session ownership TTL/LRU cache
- `tests/session-ownership-cache.test.ts` — ownership cache 的 TTL/LRU 回归测试

### Modified files
- `src/routes/messages/subagent-marker.ts` — 把“无 marker / 有效 marker / 无效 marker”区分开
- `src/lib/utils.ts` — 提供通用 session ID 归一化 helper，避免 handler 与 marker 路径重复拼 `getUUID(...)`
- `src/lib/accounts-manager.ts` — 在现有 affinity/轮转之前插入 subagent owner lookup，并为主 agent 成功请求挂 `confirmOwnership`
- `src/routes/messages/handler.ts` — subagent 只读 owner，main agent 只写 owner，并把 invalid-marker / owner-hit / owner-fallback 原因写进 instrumentation
- `tests/subagent-marker.test.ts` — richer marker inspection coverage
- `tests/utils.test.ts` — session normalization helper coverage
- `tests/accounts-manager-free-lb.test.ts` — owner hit / miss / cross-model fallback 的核心选择行为
- `tests/accounts-manager-reservation.test.ts` — owner hit 但 quota/availability 不可服务时的 fallback
- `tests/messages-handler.test.ts` — `/v1/messages` 入口如何传 ownership lookup/write 上下文
- `tests/messages-request-log-subagent.test.ts` — `selection_reason` / `is_subagent` / `affinity_key_*` 的 request log 断言

### Leave untouched unless a task proves otherwise
- `src/lib/api-config.ts`
- `src/services/copilot/create-messages.ts`
- `src/services/copilot/create-chat-completions.ts`
- `src/services/copilot/create-responses.ts`
- `src/lib/request-history.ts`
- `src/lib/admin-db.ts`

---

## Task 1: Add marker-state inspection and session ownership primitives

**Files:**
- Create: `src/lib/session-ownership.ts`
- Modify: `src/routes/messages/subagent-marker.ts`
- Modify: `src/lib/utils.ts`
- Create: `tests/session-ownership-cache.test.ts`
- Modify: `tests/subagent-marker.test.ts`
- Modify: `tests/utils.test.ts`

- [ ] **Step 1: Add failing tests for richer subagent marker inspection**

```ts
import { expect, test } from "bun:test"

import {
  inspectSubagentMarkerFromFirstUser,
  parseSubagentMarkerFromFirstUser,
} from "~/routes/messages/subagent-marker"

test("inspectSubagentMarkerFromFirstUser reports invalid when marker prefix exists but JSON is incomplete", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"s-1","agent_id":"a-1","agent_type":"Explore"</system-reminder>',
          },
        ],
      },
    ],
  } as const

  const result = inspectSubagentMarkerFromFirstUser(payload as never)

  expect(result.kind).toBe("invalid")
  expect(result.marker).toBeNull()
  expect(parseSubagentMarkerFromFirstUser(payload as never)).toBeNull()
})

test("inspectSubagentMarkerFromFirstUser reports none when no marker prefix exists", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  } as const

  expect(inspectSubagentMarkerFromFirstUser(payload as never)).toEqual({
    kind: "none",
    marker: null,
  })
})
```

- [ ] **Step 2: Add failing tests for session normalization and ownership cache behavior**

```ts
import { expect, test } from "bun:test"

import { getUUID, normalizeStableSessionId } from "~/lib/utils"
import { SessionOwnershipCache } from "~/lib/session-ownership"

test("normalizeStableSessionId trims and hashes non-empty session ids", () => {
  expect(normalizeStableSessionId(" session-123 ")).toBe(getUUID("session-123"))
  expect(normalizeStableSessionId("")).toBeUndefined()
  expect(normalizeStableSessionId(undefined)).toBeUndefined()
})

test("SessionOwnershipCache stores and returns owner account ids", () => {
  const cache = new SessionOwnershipCache(100, 60_000)
  cache.set("root-1", "acct-a")
  expect(cache.get("root-1")).toBe("acct-a")
})

test("SessionOwnershipCache evicts the oldest owner when full", () => {
  const cache = new SessionOwnershipCache(2, 60_000)
  cache.set("root-1", "acct-a")
  cache.set("root-2", "acct-b")
  cache.set("root-3", "acct-c")
  expect(cache.get("root-1")).toBeUndefined()
  expect(cache.get("root-3")).toBe("acct-c")
})
```

- [ ] **Step 3: Run focused tests and verify they fail for the right reason**

Run:

```bash
bun test "tests/subagent-marker.test.ts" "tests/utils.test.ts" "tests/session-ownership-cache.test.ts"
```

Expected:
- FAIL because `inspectSubagentMarkerFromFirstUser`, `normalizeStableSessionId`, and `SessionOwnershipCache` do not exist yet.

- [ ] **Step 4: Implement the new marker-state helper and keep the old parser as a wrapper**

```ts
// src/routes/messages/subagent-marker.ts
export type SubagentMarkerInspection =
  | { kind: "none"; marker: null }
  | { kind: "invalid"; marker: null }
  | { kind: "valid"; marker: SubagentMarker }

export const inspectSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
): SubagentMarkerInspection => {
  const firstUserMessage = payload.messages.find(
    (msg) => msg.role === "user" && Array.isArray(msg.content),
  )
  if (!firstUserMessage || !Array.isArray(firstUserMessage.content)) {
    return { kind: "none", marker: null }
  }

  for (const block of firstUserMessage.content) {
    if (block.type !== "text") continue
    const inspection = inspectSubagentMarkerFromSystemReminder(block.text)
    if (inspection.kind !== "none") return inspection
  }

  return { kind: "none", marker: null }
}

export const parseSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
): SubagentMarker | null => {
  const inspection = inspectSubagentMarkerFromFirstUser(payload)
  return inspection.kind === "valid" ? inspection.marker : null
}
```

```ts
// src/lib/utils.ts
export const normalizeStableSessionId = (
  sessionId?: string | null,
): string | undefined => {
  const trimmed = sessionId?.trim()
  return trimmed ? getUUID(trimmed) : undefined
}

export const getRootSessionId = (
  anthropicPayload: AnthropicMessagesPayload,
  c: Context,
): string | undefined => {
  const userId = anthropicPayload.metadata?.user_id
  const sessionId =
    userId ?
      parseUserIdMetadata(userId).sessionId || undefined
    : c.req.header("x-session-id")

  return normalizeStableSessionId(sessionId)
}
```

```ts
// src/lib/session-ownership.ts
interface SessionOwnershipEntry {
  accountId: string
  expiresAt: number
}

const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_TTL_MS = 60 * 60 * 1000

export class SessionOwnershipCache {
  private readonly cache = new Map<string, SessionOwnershipEntry>()

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  get(key: string): string | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    return entry.accountId
  }

  set(key: string, accountId: string): void {
    this.cache.delete(key)
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
    this.cache.set(key, {
      accountId,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  clear(): void {
    this.cache.clear()
  }
}
```

- [ ] **Step 5: Re-run the helper tests**

Run:

```bash
bun test "tests/subagent-marker.test.ts" "tests/utils.test.ts" "tests/session-ownership-cache.test.ts"
```

Expected:
- PASS for the new inspection helper, normalization helper, and ownership cache tests.

---

## Task 2: Teach `accounts-manager` to prefer the main-session owner for subagent requests

**Files:**
- Modify: `src/lib/accounts-manager.ts`
- Modify: `tests/accounts-manager-free-lb.test.ts`
- Modify: `tests/accounts-manager-reservation.test.ts`

- [ ] **Step 1: Add failing engine tests for owner hit, owner miss, and owner unusable fallback**

```ts
import { expect, test } from "bun:test"

test("subagent owner hit keeps the subagent on the main agent account across models", async () => {
  const modelA = makeModel({ id: "model-a", supported_endpoints: ["/chat/completions"] })
  const modelB = makeModel({ id: "model-b", supported_endpoints: ["/chat/completions"] })

  const a = {
    id: "a",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_a",
    models: makeModelsResponse([modelA, modelB]),
  } satisfies AccountRuntime
  const b = {
    id: "b",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_b",
    models: makeModelsResponse([modelA, modelB]),
  } satisfies AccountRuntime

  const manager = setupManager([a, b])

  const main = await manager.selectAccountForRequest(
    [{ modelId: "model-a", endpoint: "/chat/completions" }],
    { requestId: "main-session", ownershipWriteSessionId: "root-session" },
  )
  expect(main.ok).toBe(true)
  if (!main.ok) return
  expect(main.account.id).toBe("a")
  main.confirmOwnership?.()

  const subagent = await manager.selectAccountForRequest(
    [{ modelId: "model-b", endpoint: "/chat/completions" }],
    {
      requestId: "subagent-affinity-key",
      ownershipLookupSessionId: "root-session",
    },
  )

  expect(subagent.ok).toBe(true)
  if (!subagent.ok) return
  expect(subagent.account.id).toBe("a")
  expect(subagent.selectionReason).toBe("subagent_owner_hit")
})

test("subagent owner miss falls back to the existing selection path", async () => {
  const manager = setupManager([makeFreeAccount("a"), makeFreeAccount("b")])

  const selection = await manager.selectAccountForRequest(
    [{ modelId: "free-model", endpoint: "/chat/completions" }],
    {
      requestId: "subagent-fallback",
      ownershipLookupSessionId: "missing-root-session",
    },
  )

  expect(selection.ok).toBe(true)
  if (!selection.ok) return
  expect(selection.selectionReason).toBe("subagent_owner_miss")
  expect(selection.confirmOwnership).toBeUndefined()
})
```

```ts
import { expect, test } from "bun:test"

test("subagent owner unusable because of quota falls back without overwriting owner", async () => {
  const exhausted = makePremiumAccount({ id: "owner", remaining: 0 })
  const fallback = makePremiumAccount({ id: "fallback", remaining: 10 })
  const manager = setupManager([exhausted, fallback])

  const main = await manager.selectAccountForRequest(
    [{ modelId: "premium-model", endpoint: "/chat/completions" }],
    { requestId: "main-premium", ownershipWriteSessionId: "root-session" },
  )
  expect(main.ok).toBe(true)
  if (!main.ok) return
  main.confirmOwnership?.()

  exhausted.premiumRemaining = 0
  exhausted.failed = false

  const subagent = await manager.selectAccountForRequest(
    [{ modelId: "premium-model", endpoint: "/chat/completions" }],
    {
      requestId: "subagent-premium",
      ownershipLookupSessionId: "root-session",
    },
  )

  expect(subagent.ok).toBe(true)
  if (!subagent.ok) return
  expect(subagent.account.id).toBe("fallback")
  expect(subagent.selectionReason).toBe("subagent_owner_unusable_fallback")
  expect(subagent.confirmOwnership).toBeUndefined()
})
```

- [ ] **Step 2: Run the engine tests to confirm the new API is missing**

Run:

```bash
bun test "tests/accounts-manager-free-lb.test.ts" "tests/accounts-manager-reservation.test.ts"
```

Expected:
- FAIL because `ownershipLookupSessionId`, `ownershipWriteSessionId`, and `confirmOwnership` are not part of `selectAccountForRequest(...)` yet.

- [ ] **Step 3: Extend `accounts-manager` with an owner-first subagent path and a main-only ownership write callback**

```ts
// src/lib/accounts-manager.ts
import { SessionOwnershipCache } from "~/lib/session-ownership"

export type AccountSelectionReason =
  | "affinity_hit"
  | "affinity_miss"
  | "preferred_account_unavailable"
  | "no_session_key"
  | "rotated_after_miss"
  | "subagent_owner_hit"
  | "subagent_owner_miss"
  | "subagent_owner_unusable_fallback"
  | "subagent_marker_invalid_fallback"

export type AccountSelectionContext = AffinityContext & {
  ownershipLookupSessionId?: string
  ownershipWriteSessionId?: string
}

type SelectAccountForRequestSuccess = {
  ok: true
  account: AccountRuntime
  selectedModel: Model
  endpoint: string
  costUnits: number
  reservation?: QuotaReservation
  confirmAffinity?: () => void
  confirmOwnership?: () => void
  affinityHit?: boolean
  affinityCacheKey?: string
  selectionReason?: AccountSelectionReason
}

export class AccountsManager {
  private sessionOwnership = new SessionOwnershipCache()

  async selectAccountForRequest(
    candidates: Array<AccountRequestCandidate>,
    context?: AccountSelectionContext,
  ): Promise<SelectAccountForRequestResult> {
    const orderedAccounts = this.getOrderedEnabledAccounts()

    const ownerSelection = await this.selectPreferredSessionOwner({
      ownershipLookupSessionId: context?.ownershipLookupSessionId,
      orderedAccounts,
      candidates,
    })
    if (ownerSelection.result) {
      return ownerSelection.result
    }

    const affinitySelection = await this.selectWithExistingAffinityPath({
      orderedAccounts,
      candidates,
      context,
      initialSelectionReason:
        ownerSelection.selectionReason ?? getInitialSelectionReason(undefined, 0),
    })

    if (affinitySelection.ok && context?.ownershipWriteSessionId) {
      const success = affinitySelection
      success.confirmOwnership = () => {
        this.sessionOwnership.set(context.ownershipWriteSessionId!, success.account.id)
      }
    }

    return affinitySelection
  }

  private async selectPreferredSessionOwner(params: {
    ownershipLookupSessionId?: string
    orderedAccounts: Array<AccountRuntime>
    candidates: Array<AccountRequestCandidate>
  }): Promise<{
    result?: SelectAccountForRequestSuccess
    selectionReason?: AccountSelectionReason
  }> {
    const ownerSessionId = params.ownershipLookupSessionId
    if (!ownerSessionId) return {}

    const ownerId = this.sessionOwnership.get(ownerSessionId)
    if (!ownerId) {
      return { selectionReason: "subagent_owner_miss" }
    }

    const ownerResult = await this.tryAffinityAccount(
      ownerId,
      params.orderedAccounts,
      params.candidates,
    )
    if (!ownerResult) {
      return { selectionReason: "subagent_owner_unusable_fallback" }
    }

    ownerResult.selectionReason = "subagent_owner_hit"
    return { result: ownerResult, selectionReason: "subagent_owner_hit" }
  }
}
```

- [ ] **Step 4: Re-run the engine tests**

Run:

```bash
bun test "tests/accounts-manager-free-lb.test.ts" "tests/accounts-manager-reservation.test.ts"
```

Expected:
- PASS for the cross-model owner hit, owner miss fallback, and quota/unavailable fallback scenarios.

---

## Task 3: Wire `/v1/messages` so main requests write ownership and subagent requests read it

**Files:**
- Modify: `src/routes/messages/handler.ts`
- Modify: `tests/messages-handler.test.ts`
- Modify: `tests/messages-request-log-subagent.test.ts`

- [ ] **Step 1: Add failing route tests for ownership lookup/write context and invalid-marker logging**

```ts
import { expect, test } from "bun:test"

import { getUUID } from "~/lib/utils"

test("main-agent requests pass ownershipWriteSessionId but no ownershipLookupSessionId", async () => {
  let ownershipLookupSessionId: string | undefined
  let ownershipWriteSessionId: string | undefined

  accountsManager.selectAccountForRequest = (_candidates, options) => {
    ownershipLookupSessionId = options?.ownershipLookupSessionId
    ownershipWriteSessionId = options?.ownershipWriteSessionId
    return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
  }

  const response = await messageRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-123",
      },
      body: JSON.stringify(createPayload()),
    }),
  )

  expect(response.status).toBe(200)
  expect(ownershipLookupSessionId).toBeUndefined()
  expect(ownershipWriteSessionId).toBe(getUUID("session-123"))
})

test("subagent requests pass ownershipLookupSessionId derived from marker session_id", async () => {
  let ownershipLookupSessionId: string | undefined
  let ownershipWriteSessionId: string | undefined

  accountsManager.selectAccountForRequest = (_candidates, options) => {
    ownershipLookupSessionId = options?.ownershipLookupSessionId
    ownershipWriteSessionId = options?.ownershipWriteSessionId
    return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
  }

  const response = await messageRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "header-session",
      },
      body: JSON.stringify(
        createPayload({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"root-session-1","agent_id":"agent-1","agent_type":"Plan"}</system-reminder>',
                },
                { type: "text", text: "hello" },
              ],
            },
          ],
        }),
      ),
    }),
  )

  expect(response.status).toBe(200)
  expect(ownershipLookupSessionId).toBe(getUUID("root-session-1"))
  expect(ownershipWriteSessionId).toBeUndefined()
})
```

```ts
import { expect, test } from "bun:test"

test("invalid subagent marker logs subagent_marker_invalid_fallback", async () => {
  const response = await messageRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "stable-session-for-subagent-test",
      },
      body: JSON.stringify(
        createPayload({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"broken","agent_id":"agent-1","agent_type":"Explore"</system-reminder>',
                },
                { type: "text", text: "hello" },
              ],
            },
          ],
        }),
      ),
    }),
  )

  expect(response.status).toBe(200)
  const log = getLatestRequestLog()
  expect(log?.selection_reason).toBe("subagent_marker_invalid_fallback")
})
```

- [ ] **Step 2: Run the route tests to confirm the new context is still missing**

Run:

```bash
bun test "tests/messages-handler.test.ts" "tests/messages-request-log-subagent.test.ts"
```

Expected:
- FAIL because the handler does not yet pass ownership lookup/write fields or log `subagent_marker_invalid_fallback`.

- [ ] **Step 3: Implement main-write / subagent-read ownership wiring in the handler**

```ts
// src/routes/messages/handler.ts
import { inspectSubagentMarkerFromFirstUser } from "./subagent-marker"
import { normalizeStableSessionId } from "~/lib/utils"

const markerInspection = inspectSubagentMarkerFromFirstUser(anthropicPayload)
const subagentMarker =
  markerInspection.kind === "valid" ? markerInspection.marker : null
const initiatorOverride = subagentMarker ? "agent" : undefined

const sessionId = getRootSessionId(anthropicPayload, c)
const ownershipLookupSessionId =
  markerInspection.kind === "valid" ?
    normalizeStableSessionId(markerInspection.marker.session_id)
  : undefined
const ownershipWriteSessionId =
  markerInspection.kind === "none" ? sessionId : undefined

const selection = await accountsManager.selectAccountForRequest(candidates, {
  requestId: affinityKey.requestId,
  affinityModelId,
  ownershipLookupSessionId,
  ownershipWriteSessionId,
})

const loggedSelectionReason =
  markerInspection.kind === "invalid" ?
    "subagent_marker_invalid_fallback"
  : selection.selectionReason

const instr: InstrumentationContext = {
  ...existingFields,
  confirmAffinity: selection.confirmAffinity,
  confirmOwnership: selection.confirmOwnership,
  selectionReason: loggedSelectionReason,
}
```

```ts
// in all three successful upstream branches inside src/routes/messages/handler.ts
instr.confirmAffinity?.()
instr.confirmOwnership?.()
```

- [ ] **Step 4: Re-run the route tests**

Run:

```bash
bun test "tests/messages-handler.test.ts" "tests/messages-request-log-subagent.test.ts"
```

Expected:
- PASS for main-write / subagent-read context wiring and invalid-marker request-log coverage.

---

## Task 4: Run the full focused regression suite and clean up any type drift

**Files:**
- Verify: `tests/subagent-marker.test.ts`
- Verify: `tests/utils.test.ts`
- Verify: `tests/session-ownership-cache.test.ts`
- Verify: `tests/accounts-manager-free-lb.test.ts`
- Verify: `tests/accounts-manager-reservation.test.ts`
- Verify: `tests/messages-handler.test.ts`
- Verify: `tests/messages-request-log-subagent.test.ts`

- [ ] **Step 1: Run the focused test suite**

Run:

```bash
bun test \
  "tests/subagent-marker.test.ts" \
  "tests/utils.test.ts" \
  "tests/session-ownership-cache.test.ts" \
  "tests/accounts-manager-free-lb.test.ts" \
  "tests/accounts-manager-reservation.test.ts" \
  "tests/messages-handler.test.ts" \
  "tests/messages-request-log-subagent.test.ts"
```

Expected:
- PASS for all touched helpers, engine logic, and `/v1/messages` route coverage.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected:
- PASS with no new type errors around `AccountSelectionReason`, `confirmOwnership`, or the richer marker inspection helper.

- [ ] **Step 3: Run lint**

Run:

```bash
bun run lint
```

Expected:
- PASS with no unused imports, dead branches, or naming drift.

- [ ] **Step 4: Manually inspect the final behavior against the spec**

Checklist:

```text
- main agent still routes with the existing path
- main agent success writes rootSessionId -> accountId ownership
- valid subagent marker reads ownership before affinity/rotation
- subagent never writes ownership
- cross-model subagent requests still follow the main agent account when owner is usable
- owner miss / owner unusable both fall back without breaking non-subagent behavior
- invalid marker is observable as subagent_marker_invalid_fallback
```

Expected:
- Every checklist item maps cleanly to a passing test or an explicit code branch.

---

## Spec coverage check

- **Subagent follows main-agent account across models** — Task 2 + Task 3
- **Subagent is read-only for ownership; main agent is write-only** — Task 2 + Task 3
- **Owner unusable falls back safely** — Task 2 + Task 4
- **Invalid marker degrades cleanly and remains observable** — Task 1 + Task 3
- **Non-subagent behavior remains unchanged** — Task 3 + Task 4

## Placeholder scan

This plan intentionally avoids:
- `TODO` / `TBD`
- vague “handle edge cases” language
- undefined helper names without example signatures
- commit steps (omitted per user instruction)

## Type consistency check

Keep these names exactly aligned through implementation:
- `inspectSubagentMarkerFromFirstUser`
- `normalizeStableSessionId`
- `SessionOwnershipCache`
- `ownershipLookupSessionId`
- `ownershipWriteSessionId`
- `confirmOwnership`
- `subagent_owner_hit`
- `subagent_owner_miss`
- `subagent_owner_unusable_fallback`
- `subagent_marker_invalid_fallback`
