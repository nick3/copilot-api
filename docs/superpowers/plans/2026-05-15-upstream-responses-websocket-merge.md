# Upstream Responses WebSocket Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the current `caozhiyuan` → `all` merge by importing the shared Responses API WebSocket functionality while preserving `all` branch multi-account and Admin-UI architecture.

**Architecture:** Keep `all` as the source of truth for route orchestration, account selection, quota reservation, affinity, request-history, and Admin-UI. Treat upstream WebSocket support as a new transport inside the existing Responses client and route utilities. Reject Electron-only changes and any single-account global-token assumptions.

**Tech Stack:** Bun, TypeScript, Hono, Undici WebSocket, `fetch-event-stream`, project `AccountContext`, Bun test runner.

---

## File Structure

- `src/lib/config.ts` adds `useResponsesApiWebSocket` with default `true` and an accessor used by route utilities.
- `src/lib/api-config.ts` keeps `all` account-aware header generation and adds `copilotWebSocketHeaders` for WebSocket requests.
- `src/lib/copilot-rate-limit.ts` keeps HTTP header parsing and adds quota snapshot parsing for WebSocket terminal events.
- `src/lib/proxy.ts` exposes the per-URL dispatcher so WebSocket can reuse proxy env config under Bun.
- `src/routes/responses/utils.ts` owns transport selection via model `supported_endpoints`, config, and compact fallback.
- `src/services/copilot/create-responses.ts` owns HTTP/WebSocket execution while accepting `AccountContext` and never reading global token for account-specific data.
- `src/routes/messages/handler.ts` and `src/routes/responses/handler.ts` keep existing `all` orchestration and pass selected transport into `createResponses`.
- Tests under `tests/` migrate upstream WebSocket behavior into current `all` test layout.
- `README.md` and `README.zh-CN.md` document only the shared `useResponsesApiWebSocket` setting, not Electron UI.

---

### Task 1: Resolve Non-UI Config And Support Utilities

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/lib/api-config.ts`
- Modify: `src/lib/copilot-rate-limit.ts`
- Modify: `src/lib/proxy.ts`
- Test: `tests/copilot-rate-limit.test.ts`
- Test: `tests/api-config.test.ts` if existing assertions require header coverage

- [ ] **Step 1: Add config test for WebSocket default and override**

Add assertions near existing config default tests:

```ts
expect(isResponsesApiWebSocketEnabled()).toBe(true)
config.useResponsesApiWebSocket = false
expect(isResponsesApiWebSocketEnabled()).toBe(false)
```

- [ ] **Step 2: Add quota snapshot test**

Add a test to `tests/copilot-rate-limit.test.ts`:

```ts
expect(
  getCopilotRateLimitUsageFromSnapshots(
    {
      "5Hour-Session-RateLimits": {
        entitlement: "chat",
        percent_remaining: 42,
        overage_permitted: false,
        overage_count: 0,
        reset_date: "2026-01-01T00:00:00Z",
      },
    },
    "session",
  ),
).toEqual({
  remaining: "42",
  resetAt: "2026-01-01T00:00:00Z",
  type: "session",
})
```

- [ ] **Step 3: Implement minimal support utilities**

Use upstream logic but keep existing imports and account-aware function signatures. Add `useResponsesApiWebSocket?: boolean`, default `true`, and `isResponsesApiWebSocketEnabled()`. Add `copilotWebSocketHeaders(preparedHeaders)` without changing existing `copilotHeaders(ctx, ...)` semantics. Add `getProxyEnvDispatcher()` while preserving current HTTP dispatcher behavior.

- [ ] **Step 4: Run focused utility tests**

Run: `bun test tests/copilot-rate-limit.test.ts tests/api-config.test.ts`

Expected: all tests in these files pass.

---

### Task 2: Resolve Transport Selection

**Files:**
- Modify: `src/routes/responses/utils.ts`
- Test: `tests/messages-api-flows.test.ts` or existing responses utility coverage

- [ ] **Step 1: Add transport selection tests**

Cover these cases:

```ts
expect(getResponsesTransportForModel({ supported_endpoints: ["ws:/responses", "/responses"] })).toBe("websocket")
expect(getResponsesTransportForModel({ supported_endpoints: ["/responses"] })).toBe("http")
expect(getResponsesTransportForModel({ supported_endpoints: ["ws:/responses"] }, { compactType: COMPACT_REQUEST })).toBe(null)
```

When config disables WebSocket:

```ts
responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () => false
expect(getResponsesTransportForModel({ supported_endpoints: ["ws:/responses", "/responses"] })).toBe("http")
```

- [ ] **Step 2: Implement transport utility**

Add constants `RESPONSES_ENDPOINT = "/responses"` and `RESPONSES_WS_ENDPOINT = "ws:/responses"`. Implement `getResponsesTransportForModel()` so compact requests never use WebSocket and HTTP remains fallback only when `/responses` is advertised.

- [ ] **Step 3: Run focused tests**

Run: `bun test tests/messages-api-flows.test.ts`

Expected: transport selection tests pass without changing handler orchestration.

---

### Task 3: Resolve Account-Aware Responses Client

**Files:**
- Modify: `src/services/copilot/create-responses.ts`
- Test: `tests/create-responses.test.ts`
- Test: `tests/create-responses-websocket-pool.test.ts`

- [ ] **Step 1: Add account-aware WebSocket tests**

Verify pool keys differ by token/account and include request/subagent identity:

```ts
const accountA = { ...baseAccountContext, copilotToken: "token-a" }
const accountB = { ...baseAccountContext, copilotToken: "token-b" }
expect(buildResponsesWebSocketPoolKey(payload, options, accountA)).not.toBe(
  buildResponsesWebSocketPoolKey(payload, options, accountB),
)
```

- [ ] **Step 2: Add compact fallback test**

Verify `transport: "websocket"` with `compactType: COMPACT_REQUEST` still uses HTTP fetch and does not construct WebSocket.

- [ ] **Step 3: Implement WebSocket backend**

Integrate upstream WebSocket request/pool/stream consumption, but adapt all account-specific data to `AccountContext`:

```ts
export const createResponses = async (
  payload: ResponsesPayload,
  options: ResponsesRequestOptions,
  account?: AccountContext,
): Promise<CreateResponsesReturn> => {
  const ctx = account ?? state
  if (!ctx.copilotToken) throw new Error("Copilot token not found")
  const transport = options.compactType === COMPACT_REQUEST ? "http" : options.transport ?? "http"
  const headers = copilotHeaders(ctx, options.vision, options.upstreamRequestId)
  return transport === "websocket"
    ? createWebSocketResponses(payload, headers, options, ctx)
    : createHttpResponses(payload, headers, options, ctx)
}
```

- [ ] **Step 4: Preserve HTTP path behavior**

Keep existing `fetchEventSource`/HTTP streaming behavior, `copilotBaseUrl(ctx)`, request IDs, and current `HTTPError` handling unchanged except for extracting it into `createHttpResponses()`.

- [ ] **Step 5: Run service tests**

Run: `bun test tests/create-responses.test.ts tests/create-responses-websocket-pool.test.ts`

Expected: HTTP and WebSocket service tests pass.

---

### Task 4: Resolve Route Handler Conflicts Without Reverting all Architecture

**Files:**
- Modify: `src/routes/messages/api-flows.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Test: `tests/messages-handler.test.ts`
- Test: `tests/messages-api-flows.test.ts`
- Test: any current responses handler replacement tests in `tests/`

- [ ] **Step 1: Keep `handler.ts` as `/v1/messages` source of truth**

Do not restore upstream simple single-account handler flow. Add only the transport decision and pass it into the existing Responses call.

- [ ] **Step 2: Add route-level tests**

Cover that a selected model with `ws:/responses` passes `transport: "websocket"`, compact requests pass `transport: "http"`, and account selection still receives the same request metadata.

- [ ] **Step 3: Patch `/v1/messages` Responses path**

Compute transport after selected model and compact type are known:

```ts
const transport = getResponsesTransportForModel(selectedModel, { compactType }) ?? "http"
```

Pass `transport` into `createResponses` while keeping existing `accountCtx`, quota, request-history, affinity, and ownership code intact.

- [ ] **Step 4: Patch `/v1/responses` path**

Use the same utility after `accountsManager.selectAccountForRequest()`. Do not bypass selection, reservation finalization, error logging, or request-history writes.

- [ ] **Step 5: Run route tests**

Run: `bun test tests/messages-handler.test.ts tests/messages-api-flows.test.ts tests/responses-request-log-prompt-cache-key.test.ts tests/responses-item-ownership.test.ts`

Expected: existing request logging and ownership tests still pass.

---

### Task 5: Resolve Docs, Package, And Electron Conflict

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `package.json`
- Resolve deletion: `desktop/electron/server-manager.ts`

- [ ] **Step 1: Keep Electron deleted**

Resolve `desktop/electron/server-manager.ts` as deleted. Do not reintroduce `desktop/` or Electron-specific docs.

- [ ] **Step 2: Keep package version unless release intent changes**

Keep the `all` branch version unless the user explicitly wants the upstream release bump.

- [ ] **Step 3: Add only WebSocket config docs**

Add `useResponsesApiWebSocket` to both README config examples and explain that it controls WebSocket transport for models advertising `ws:/responses`.

- [ ] **Step 4: Run package consistency check**

Run: `bun run lint`

Expected: lint exits 0 or only reports unrelated pre-existing issues.

---

### Task 6: Final Verification

**Files:**
- All resolved merge files

- [ ] **Step 1: Confirm no conflict markers**

Run: `rg "<<<<<<<|=======|>>>>>>>" README.md README.zh-CN.md package.json src tests`

Expected: no matches.

- [ ] **Step 2: Confirm Git has no unresolved paths**

Run: `git status --short`

Expected: no `UU`, `AA`, or `DU` entries remain for merge conflicts.

- [ ] **Step 3: Run focused test suite**

Run: `bun test tests/copilot-rate-limit.test.ts tests/api-config.test.ts tests/create-responses.test.ts tests/create-responses-websocket-pool.test.ts tests/messages-api-flows.test.ts tests/messages-handler.test.ts tests/responses-item-ownership.test.ts tests/responses-request-log-prompt-cache-key.test.ts`

Expected: all focused tests pass.

- [ ] **Step 4: Run broad validation**

Run: `bun run typecheck && bun test`

Expected: typecheck and full tests pass, or failures are clearly unrelated to this merge and documented.
