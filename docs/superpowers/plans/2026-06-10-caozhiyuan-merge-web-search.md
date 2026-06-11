# caozhiyuan Merge Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the `caozhiyuan` -> `all` merge conflicts while preserving `all` multi-account/Admin-UI architecture and absorbing shared WebSearch/openai-responses provider functionality.

**Architecture:** Keep `all` as the base architecture for `/v1/messages`, provider routing, request history, affinity, and injectable provider fetch. Merge only additive `caozhiyuan` behavior: Anthropic `web_search` routing, `openai-responses` provider messages support, richer Responses stream error events, and `output_config.effort` preservation. Exclude Electron UI revival and avoid reverting multi-account/provider alias contracts.

**Tech Stack:** TypeScript, Hono, Bun test runner, Git merge conflict resolution, existing Copilot/Anthropic/OpenAI Responses translation utilities.

---

## File Structure

- `README.md` / `README.zh-CN.md`: preserve `all` documentation and add WebSearch/provider routing notes.
- `desktop/package.json`: keep deleted; Electron UI is out of scope.
- `src/lib/config.ts`: preserve `all` config shape and include explicit `messageApiWebSearchModel` default only if needed.
- `src/routes/messages/handler.ts`: preserve `all` orchestration, insert WebSearch handling after model mapping and before provider/main account routing.
- `src/routes/provider/messages/handler.ts`: preserve `all` instrumentation/fetch injection, add `openai-responses` provider messages and WebSearch bridge.
- `src/services/copilot/create-responses.ts`: accept additive richer `ResponseErrorEvent` shape.
- `src/services/providers/provider-proxy.ts`: preserve `all` injectable `fetchImpl` implementation.
- `tests/messages-handler.test.ts`: preserve `all` harness; add only behavior-level assertions if necessary.
- `tests/web-search-fulfill.test.ts` and `tests/provider-messages-web-search.test.ts`: keep upstream tests and adapt only if they conflict with `all` architecture.

---

### Task 1: Resolve low-risk conflict files

**Files:**
- Modify: `desktop/package.json`
- Modify: `src/services/providers/provider-proxy.ts`
- Modify: `src/services/copilot/create-responses.ts`
- Modify: `src/lib/config.ts`

- [ ] **Step 1: Keep Electron deleted**

Run:

```bash
git checkout --ours -- "desktop/package.json"
git rm -- "desktop/package.json"
```

Expected: `desktop/package.json` remains deleted and no Electron package is restored.

- [ ] **Step 2: Preserve injectable provider proxy**

Run:

```bash
git checkout --ours -- "src/services/providers/provider-proxy.ts"
```

Expected: `forwardProviderMessages` and `forwardProviderChatCompletions` still accept/use `fetchImpl` rather than hardcoded global `fetch`.

- [ ] **Step 3: Accept richer Responses error event**

Run:

```bash
git checkout --theirs -- "src/services/copilot/create-responses.ts"
```

Expected: `ResponseErrorEvent` includes optional `error`, `status_code`, and `headers` fields without removing local public APIs.

- [ ] **Step 4: Merge config defaults manually**

Edit `src/lib/config.ts` so `defaultConfig` includes all `all` fields and explicitly contains:

```ts
messageApiWebSearchModel: "gpt-5-mini",
```

Expected: `logLevel`, `devMode`, `quotaRefresh`, provider types, and WebSearch config all coexist.

---

### Task 2: Resolve `/v1/messages` orchestration conflict

**Files:**
- Modify: `src/routes/messages/handler.ts`
- Test: `tests/messages-handler.test.ts`
- Test: `tests/web-search-fulfill.test.ts`

- [ ] **Step 1: Use `all` handler as base**

Keep the `all` version of `src/routes/messages/handler.ts` as structural base. Preserve these symbols and behaviors:

```ts
accountsManager.selectAccountForRequest
confirmAffinity
confirmOwnership
resolveProviderTargetModelAlias
handleProviderAliasCompletion
InstrumentationContext
maybeBlockOriginalModelName
inspectSubagentMarkerFromFirstUser
```

Expected: no simplification to a single-account dispatcher and no loss of request history/affinity/ownership logic.

- [ ] **Step 2: Add WebSearch imports and call site**

Import upstream WebSearch helpers already present in `src/routes/messages/web-search/fulfill.ts`, then call `tryHandleWebSearch(...)` after model mapping/alias normalization and before provider alias/main Copilot account routing.

Expected call order:

```text
parse payload
resolve mapped/alias model
tryHandleWebSearch
provider alias handling
account selection
upstream endpoint routing
```

- [ ] **Step 3: Preserve provider model alias semantics**

Ensure `modelAliases -> provider/model` continues to work by preserving the local two-stage resolution path:

```ts
resolveModelAlias(...)
resolveExistingProviderModelAlias(...)
```

Expected: direct `provider/model` and configured aliases pointing to `provider/model` both work.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
bun test tests/web-search-fulfill.test.ts tests/messages-handler.test.ts
```

Expected: WebSearch fulfillment and existing messages handler tests pass.

---

### Task 3: Resolve provider messages conflict

**Files:**
- Modify: `src/routes/provider/messages/handler.ts`
- Test: `tests/provider-messages-web-search.test.ts`

- [ ] **Step 1: Use `all` provider handler as base**

Preserve these local seams and helpers:

```ts
ProviderMessagesInstrumentation
getProviderFetch(c)
resolveProviderConfig(...)
normalizeAnthropicUsage
mergeAnthropicUsage
```

Expected: tests can still inject provider fetch/config and existing Anthropic/openai-compatible provider behavior remains intact.

- [ ] **Step 2: Add `openai-responses` provider branch**

When `providerConfig.type === "openai-responses"`, route Anthropic messages through the Responses provider bridge instead of returning unsupported provider type.

Expected behavior:

```text
Anthropic Messages request
→ provider messages handler
→ openai-responses provider translation
→ provider /responses
→ Anthropic Messages JSON/SSE response
```

- [ ] **Step 3: Add provider WebSearch bridge**

For pure Anthropic `web_search` requests, call the provider WebSearch handling path that prepares a Responses payload and reconstructs Anthropic output.

Expected: `server_tool_use`, `web_search_tool_result`, citations, and streaming events are reconstructed by existing translation helpers.

- [ ] **Step 4: Run provider WebSearch tests**

Run:

```bash
bun test tests/provider-messages-web-search.test.ts
```

Expected: provider `openai-responses`, Codex, JSON, and streaming WebSearch behavior pass.

---

### Task 4: Resolve docs and messages handler tests

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `tests/messages-handler.test.ts`

- [ ] **Step 1: Preserve `all` tests as base**

Keep `tests/messages-handler.test.ts` based on `all`; do not replace it with `caozhiyuan`'s refactor-specific harness.

Expected: existing multi-account, warmup, request-history, and routing tests remain meaningful.

- [ ] **Step 2: Add only necessary behavior assertions**

If WebSearch behavior is not already covered by `tests/web-search-fulfill.test.ts`, add a focused assertion to `tests/messages-handler.test.ts` that top-level `/v1/messages` invokes WebSearch handling for pure WebSearch requests.

Expected: no duplicated provider tests and no dependency on removed `messagesFlowHandlers` façade.

- [ ] **Step 3: Preserve `all` README structure and add WebSearch notes**

Add concise documentation for:

```text
- Claude Messages web_search support
- messageApiWebSearchModel
- provider/model target support
- mixed web_search + client tools behavior
```

Expected: docs mention new shared behavior without removing Admin-UI/multi-account content.

---

### Task 5: Final verification

**Files:**
- Verify entire merge working tree.

- [ ] **Step 1: Check no unresolved conflict markers remain**

Run:

```bash
git diff --check
```

Expected: no conflict markers or whitespace errors.

- [ ] **Step 2: Run focused merge test set**

Run:

```bash
bun test tests/web-search-fulfill.test.ts tests/provider-messages-web-search.test.ts tests/messages-handler.test.ts tests/messages-preprocess.test.ts tests/provider-model-alias.test.ts tests/chat-completions-handler.test.ts
```

Expected: all listed test files pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: TypeScript passes.

- [ ] **Step 4: Run lint if typecheck passes**

Run:

```bash
bun run lint
```

Expected: lint passes or reports only pre-existing unrelated issues with exact output captured.

---

## Self-Review

- Spec coverage: The plan covers required conflict resolution, WebSearch, provider `openai-responses`, richer Responses errors, Electron exclusion, docs, and verification.
- Placeholder scan: No TBD/TODO placeholders remain; each task has concrete file paths and commands.
- Type consistency: Function and config names match the analysis outputs and project naming conventions.
