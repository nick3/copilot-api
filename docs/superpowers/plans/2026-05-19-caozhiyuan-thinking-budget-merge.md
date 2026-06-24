# Caozhiyuan v1.10.9 Merge Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the reusable `caozhiyuan` v1.10.9 changes into `all` while preserving the `nick3` fork identity, multi-account routing, Admin-UI, and the recently fixed model alias behavior.

**Architecture:** Treat `caozhiyuan` as an upstream feature source, not as the target architecture. Accept only the OpenAI-compatible provider `thinking_budget` support, its tests/docs, and the root package version bump; reject the upstream Electron/single-account surface and any package identity changes.

**Tech Stack:** TypeScript, Hono, Bun test runner, Git merge conflict resolution.

---

## Functional merge decision

### Accept from `caozhiyuan`

1. **OpenAI-compatible provider `thinking_budget` support**
   - Source commit: `996c7d3e33054c916db201601971a97e4a83e06c`.
   - Functional effect: Anthropic `thinking.budget_tokens` is translated to OpenAI-compatible upstream `thinking_budget` for provider routes such as `/dash/v1/messages`.
   - Functional override: per-model `extraBody.thinking_budget` is applied after request-derived translation, so provider configuration can force the final budget.
   - Files already auto-merged cleanly:
     - `src/routes/provider/messages/handler.ts`
     - `tests/provider-openai-compatible.test.ts`
     - `README.md`
     - `README.zh-CN.md`

2. **Root package version bump to `1.10.9`**
   - Source commit: `573a14793525010f7ddc17bc2ab829aa6143faf0`.
   - Accept only the root package version value.
   - Preserve package identity as `@nick3/copilot-api`.

### Reject from `caozhiyuan`

1. `@jeffreycao/copilot-api` package identity.
2. `desktop/package.json` and Electron desktop packaging/version changes.
3. Any changes that remove or downgrade `admin-ui/**`.
4. Any changes that collapse the `all` branch multi-account model back to a single upstream Copilot account.
5. Any changes that remove Admin API, request history, dev-mode replay, quota reservation, account affinity, or model alias logic.
6. Any release workflow or README wording that points users to `caozhiyuan/copilot-api` instead of `nick3/copilot-api`.

---

## File responsibilities

- `package.json`
  - Resolve the only unmerged conflict.
  - Final top-level metadata must be:

    ```json
    {
      "$schema": "https://json.schemastore.org/package.json",
      "name": "@nick3/copilot-api",
      "version": "1.10.9"
    }
    ```

- `src/routes/provider/messages/handler.ts`
  - Keep the auto-merged `thinking_budget` translation helpers.
  - Keep the existing `all` provider routing, fetch injection, instrumentation, and response translation flow.

- `tests/provider-openai-compatible.test.ts`
  - Keep the two auto-merged regression tests:
    - maps Anthropic `thinking.budget_tokens` to upstream `thinking_budget`.
    - lets `extraBody.thinking_budget` override request-derived budget.

- `README.md` and `README.zh-CN.md`
  - Keep only the provider `extraBody.thinking_budget` documentation addition.
  - Preserve `nick3` package/repository naming and Admin-UI/multi-account documentation.

---

## Task 1: Resolve root package conflict

**Files:**
- Modify: `package.json:1-8`

- [ ] **Step 1: Replace the conflict block**

Replace the current conflict section where the HEAD side keeps `"name": "@nick3/copilot-api"` with version `1.10.8`, while the caozhiyuan side changes it to `"name": "@jeffreycao/copilot-api"` with version `1.10.9`, with:

```json
  "name": "@nick3/copilot-api",
  "version": "1.10.9",
```

- [ ] **Step 2: Verify no conflict markers remain in the resolved file**

Run:

```bash
git diff --check -- "package.json"
```

Expected: no output and exit code `0`.

- [ ] **Step 3: Mark only the resolved package file as staged**

Run:

```bash
git add "package.json"
```

Expected: `package.json` no longer appears as `UU` in `git status --short`.

---

## Task 2: Preserve the accepted provider feature

**Files:**
- Keep: `src/routes/provider/messages/handler.ts:235-365`
- Keep: `tests/provider-openai-compatible.test.ts:246-305`
- Keep: `README.md:438`
- Keep: `README.zh-CN.md:447`

- [ ] **Step 1: Confirm the provider translation helpers remain present**

Run:

```bash
git diff --cached -- "src/routes/provider/messages/handler.ts"
```

Expected diff includes these function names:

```ts
getRequestThinkingBudget
applyOpenAICompatibleThinkingBudget
applyOpenAICompatibleExtraBodyThinkingBudget
```

- [ ] **Step 2: Confirm request-derived budget is applied before `extraBody` override**

In `src/routes/provider/messages/handler.ts`, the order inside `createOpenAICompatiblePayload()` must remain:

```ts
applyOpenAICompatibleThinkingBudget(openAIPayload, payload)
applyOpenAICompatibleRequestOverrides(openAIPayload, {
  extraBody: modelConfig?.extraBody,
  source: payload as unknown as Record<string, unknown>,
})
applyMissingExtraBody(openAIPayload, {
  extraBody: modelConfig?.extraBody,
})
applyOpenAICompatibleExtraBodyThinkingBudget(openAIPayload, {
  extraBody: modelConfig?.extraBody,
})
```

- [ ] **Step 3: Confirm regression tests remain present**

Run:

```bash
git diff --cached -- "tests/provider-openai-compatible.test.ts"
```

Expected diff includes both test names:

```ts
maps Anthropic thinking budget to OpenAI-compatible thinking_budget
forces thinking_budget from extraBody over request thinking budget
```

---

## Task 3: Reject upstream-only surface area

**Files:**
- Do not modify: `admin-ui/**`
- Do not modify: `src/lib/accounts-manager.ts`
- Do not modify: `src/lib/request-history.ts`
- Do not modify: `src/routes/admin-api/**`
- Do not modify: `desktop/**`

- [ ] **Step 1: Confirm the merge did not stage upstream UI architecture changes**

Run:

```bash
git diff --cached --name-only
```

Expected tracked merge changes are limited to:

```text
README.md
README.zh-CN.md
package.json
src/routes/provider/messages/handler.ts
tests/provider-openai-compatible.test.ts
```

- [ ] **Step 2: Confirm rejected upstream package identity is absent from resolved tracked files**

Run:

```bash
git diff --cached -- "README.md" "README.zh-CN.md" "package.json"
```

Expected: no `@jeffreycao/copilot-api` and no `caozhiyuan/copilot-api` references in these staged changes.

---

## Task 4: Verify behavior and guard against alias regression

**Files:**
- Test: `tests/provider-openai-compatible.test.ts`
- Test: `tests/provider-model-alias.test.ts`
- Test: `tests/messages-handler.test.ts`

- [ ] **Step 1: Verify provider `thinking_budget` behavior**

Run:

```bash
bun test "tests/provider-openai-compatible.test.ts"
```

Expected: pass.

- [ ] **Step 2: Verify the recently fixed model alias behavior still works**

Run:

```bash
bun test "tests/provider-model-alias.test.ts" "tests/messages-handler.test.ts"
```

Expected: pass. Warnings from mocked upstream failures are acceptable only when the test exits successfully.

- [ ] **Step 3: Verify TypeScript and lint gates**

Run:

```bash
bun run typecheck && bun run lint
```

Expected: both commands exit with code `0`.

- [ ] **Step 4: Confirm no unresolved conflicts remain**

Run:

```bash
git diff --name-only --diff-filter=U
```

Expected: empty output.

---

## Self-review

- Spec coverage: the plan covers upstream commit `996c7d3` (`thinking_budget`) and `573a147` (version bump), plus the `all` branch preservation constraints.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: the plan uses existing project types/functions and does not introduce new public interfaces beyond the upstream helper functions already auto-merged.

## Execution boundary

This plan intentionally does not include `git commit`, `git push`, or PR creation. Those require a separate explicit user instruction after local conflict resolution and verification.
