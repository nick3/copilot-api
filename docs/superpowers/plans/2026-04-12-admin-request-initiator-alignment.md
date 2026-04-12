# Admin Request Initiator Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new request-log `initiator` values match the actual outbound `x-initiator` sent to Copilot upstream requests.

**Architecture:** Introduce a shared `resolveEffectiveInitiator()` helper that expresses the final outbound initiator semantics once, then reuse it in both request-history recording and upstream header construction. Keep storage and UI schemas unchanged so only new records change behavior, while compact and subagent upstream rules remain intact.

**Tech Stack:** TypeScript, Bun test runner, Hono routes, SQLite-backed request history

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/request-initiator.ts` | Shared helper for resolving the final outbound initiator from base initiator plus compact/subagent overrides |
| `tests/request-initiator.test.ts` | Unit coverage for effective initiator resolution rules |

### Modified Files

| File | Changes |
|------|---------|
| `src/services/copilot/create-messages.ts` | Replace inline compact/subagent header override logic with the shared helper |
| `src/services/copilot/create-chat-completions.ts` | Reuse the shared helper when setting `x-initiator` |
| `src/services/copilot/create-responses.ts` | Reuse the shared helper when setting `x-initiator` |
| `src/routes/messages/handler.ts` | Record `effectiveInitiator` into `instr.initiator` before request history insert |
| `tests/create-messages.test.ts` | Verify compact requests still send `x-initiator: agent` through the shared helper path |
| `tests/create-chat-completions.test.ts` | Verify compact requests still send `x-initiator: agent` through the shared helper path |
| `tests/messages-request-log-subagent.test.ts` | Add a compact request-log regression so stored `initiator` matches the effective outbound value |

---

## Task 1: Lock the effective initiator rule in a shared helper

Create a single source of truth for outbound initiator resolution before touching request logging or upstream header construction.

**Files:**
- Create: `src/lib/request-initiator.ts`
- Create: `tests/request-initiator.test.ts`
- Test: `tests/request-initiator.test.ts`

- [ ] **Step 1: Add failing unit tests for base, compact, and subagent cases**

```ts
import { describe, expect, test } from "bun:test"

import { resolveEffectiveInitiator } from "~/lib/request-initiator"

describe("resolveEffectiveInitiator", () => {
  test("returns the base initiator for ordinary requests", () => {
    expect(
      resolveEffectiveInitiator("user", {
        isCompact: false,
        isSubagent: false,
      }),
    ).toBe("user")
  })

  test("forces agent for compact requests", () => {
    expect(
      resolveEffectiveInitiator("user", {
        isCompact: true,
        isSubagent: false,
      }),
    ).toBe("agent")
  })

  test("forces agent for subagent requests", () => {
    expect(
      resolveEffectiveInitiator("user", {
        isCompact: false,
        isSubagent: true,
      }),
    ).toBe("agent")
  })
})
```

- [ ] **Step 2: Run the new unit test file and verify it fails before implementation**

Run:
```bash
bun test "tests/request-initiator.test.ts"
```
Expected: FAIL because `~/lib/request-initiator` does not exist yet.

- [ ] **Step 3: Implement the shared helper**

```ts
export function resolveEffectiveInitiator(
  baseInitiator: "agent" | "user",
  options: {
    isCompact?: boolean
    isSubagent?: boolean
  },
): "agent" | "user" {
  if (options.isCompact || options.isSubagent) {
    return "agent"
  }

  return baseInitiator
}
```

- [ ] **Step 4: Re-run the helper unit test**

Run:
```bash
bun test "tests/request-initiator.test.ts"
```
Expected: PASS.

---

## Task 2: Make all upstream header builders use the shared helper

Switch outbound header construction to the shared helper so the final header value and future request-log value stay aligned.

**Files:**
- Modify: `src/services/copilot/create-messages.ts`
- Modify: `src/services/copilot/create-chat-completions.ts`
- Modify: `src/services/copilot/create-responses.ts`
- Modify: `tests/create-messages.test.ts`
- Modify: `tests/create-chat-completions.test.ts`
- Test: `tests/create-messages.test.ts`
- Test: `tests/create-chat-completions.test.ts`

- [ ] **Step 1: Import and use the shared helper in `create-messages.ts`**

```ts
import { resolveEffectiveInitiator } from "~/lib/request-initiator"
```

```ts
const effectiveInitiator = resolveEffectiveInitiator(initiator, {
  isCompact: options?.isCompact,
  isSubagent: Boolean(options?.subagentMarker),
})

const headers: Record<string, string> = {
  ...copilotHeaders(ctx, enableVision, options?.upstreamRequestId),
  "x-initiator": effectiveInitiator,
}
```

- [ ] **Step 2: Import and use the shared helper in `create-chat-completions.ts`**

```ts
import { resolveEffectiveInitiator } from "~/lib/request-initiator"
```

```ts
const effectiveInitiator = resolveEffectiveInitiator(initiator, {
  isCompact: options?.isCompact,
  isSubagent: Boolean(options?.subagentMarker),
})

const headers: Record<string, string> = {
  ...copilotHeaders(ctx, enableVision, options?.upstreamRequestId),
  "x-initiator": effectiveInitiator,
}
```

- [ ] **Step 3: Import and use the shared helper in `create-responses.ts`**

```ts
import { resolveEffectiveInitiator } from "~/lib/request-initiator"
```

```ts
const effectiveInitiator = resolveEffectiveInitiator(initiator, {
  isCompact,
  isSubagent: Boolean(subagentMarker),
})

const headers: Record<string, string> = {
  ...copilotHeaders(ctx, vision, upstreamRequestId),
  "x-initiator": effectiveInitiator,
}
```

- [ ] **Step 4: Add compact regression coverage to `tests/create-messages.test.ts`**

```ts
test("forces x-initiator to agent for compact requests", async () => {
  const payload = basePayload([
    {
      type: "text",
      text: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far.\n\n7. Pending Tasks:\n   - [Task 1]\n\n8. Current Work:\n   [Current work]",
    },
  ])

  await createMessages(payload, accountContext, {
    isCompact: true,
  })

  expect(getLastHeaders()["x-initiator"]).toBe("agent")
})
```

- [ ] **Step 5: Add compact regression coverage to `tests/create-chat-completions.test.ts`**

```ts
test("forces x-initiator to agent for compact chat requests", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "compact summary prompt" }],
    model: "gpt-test",
  }

  await createChatCompletions(payload, undefined, {
    isCompact: true,
  })

  const { headers } = getLastFetchCall()
  expect(headers["x-initiator"]).toBe("agent")
})
```

- [ ] **Step 6: Run the targeted upstream-header tests**

Run:
```bash
bun test "tests/request-initiator.test.ts" "tests/create-messages.test.ts" "tests/create-chat-completions.test.ts"
```
Expected: PASS, with compact and subagent header behavior unchanged.

---

## Task 3: Record the effective initiator into request history

Align the stored request-log value with the actual outbound header semantics for new messages requests.

**Files:**
- Modify: `src/routes/messages/handler.ts`
- Modify: `tests/messages-request-log-subagent.test.ts`
- Test: `tests/messages-request-log-subagent.test.ts`

- [ ] **Step 1: Add a compact request-log regression test**

```ts
test("records agent initiator for compact requests", async () => {
  mockSuccessfulMessagesFetch()

  const compactPrompt = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.\n\n7. Pending Tasks:\n   - [Task 1]\n\n8. Current Work:\n   [Current work]`

  const response = await messageRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createPayload({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: compactPrompt,
                },
              ],
            },
          ],
        }),
      ),
    }),
  )

  const latest = getLatestRequestLog()

  expect(response.status).toBe(200)
  expect(latest?.initiator).toBe("agent")
})
```

- [ ] **Step 2: Compute `effectiveInitiator` before assigning `instr.initiator` in each messages-path upstream branch**

```ts
const effectiveInitiator = resolveEffectiveInitiator(initiator, {
  isCompact,
  isSubagent: Boolean(subagentMarker),
})

instr.initiator = effectiveInitiator
```

Apply the same pattern in:
- the chat-completions branch
- the responses branch
- the native messages branch

- [ ] **Step 3: Pass the same `effectiveInitiator` through to the create* calls**

```ts
response = await createMessages(anthropicPayload, ctx, {
  anthropicBetaHeader,
  upstreamRequestId: instr.upstreamRequestId,
  initiator: effectiveInitiator,
  subagentMarker,
  sessionId,
  isCompact,
})
```

Mirror the same change for `createChatCompletions(...)` and `createResponses(...)` call sites.

- [ ] **Step 4: Run the request-log regression file**

Run:
```bash
bun test "tests/messages-request-log-subagent.test.ts"
```
Expected: PASS, with compact requests now recording `agent` and existing subagent coverage still passing.

- [ ] **Step 5: Run the final targeted verification set**

Run:
```bash
bun test "tests/request-initiator.test.ts" "tests/create-messages.test.ts" "tests/create-chat-completions.test.ts" "tests/messages-request-log-subagent.test.ts"
```
Expected: PASS.

---

## Execution Notes

- Do **not** backfill historical request-log rows; this plan only changes newly written records.
- Do **not** add a database migration; existing schema is sufficient.
- Do **not** create a git commit unless the user explicitly asks for one.
