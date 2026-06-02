# Issue #56 Subagent Marker Parser Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `__SUBAGENT_MARKER__` parsing so Claude Code runtime text appended after the JSON payload no longer causes subagent marker detection to fail.

**Architecture:** Keep the plugin contract unchanged and localize the fix to the server-side parser in `src/routes/messages/subagent-marker.ts`. Add regression tests that model the Claude Code `SubagentStart` wrapper plus trailing runtime text, then verify the parser still preserves existing valid/invalid behavior.

**Tech Stack:** TypeScript, Bun test runner, GitHub issue workflow via `gh`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| None | The fix should stay localized to existing parser and tests |

### Modified Files

| File | Changes |
|------|---------|
| `src/routes/messages/subagent-marker.ts` | Extract only the first complete JSON object after `__SUBAGENT_MARKER__` before parsing |
| `tests/subagent-marker.test.ts` | Add regression coverage for trailing runtime text and incomplete JSON object cases |

---

## Task 1: Post a scoped issue reply before code changes

Summarize the confirmed root cause, clarify the plugin/runtime boundary, and state the planned parser-side fix without over-claiming impact.

**Files:**
- Modify: None
- External: GitHub issue `nick3/copilot-api#56`

- [ ] **Step 1: Prepare the exact issue reply text**

```md
Confirmed after tracing the Claude Code plugin path:

- `claude-plugin/scripts/subagent-start-marker.js` only emits the marker through `hookSpecificOutput.additionalContext`
- the final `<system-reminder>` wrapper is added by Claude Code runtime during `SubagentStart`
- the current parser in `src/routes/messages/subagent-marker.ts` still slices from `__SUBAGENT_MARKER__` to the end of the reminder block, so any runtime text appended after the JSON payload causes `JSON.parse` to fail

I’m going to fix this in the server-side parser rather than in the plugin:

1. extract only the first complete JSON object immediately after `__SUBAGENT_MARKER__`
2. ignore trailing runtime text in the same `<system-reminder>` block
3. add regression tests for the Claude-style `SubagentStart hook additional context: ...` wrapper with trailing runtime lines

I’ll keep the scope narrow and avoid claiming broader downstream effects beyond the parser/subagent semantics that are directly observable in the current code.
```

- [ ] **Step 2: Post the issue reply**

Run:
```bash
gh issue comment "https://github.com/nick3/copilot-api/issues/56" --body "$(cat <<'EOF'
Confirmed after tracing the Claude Code plugin path:

- `claude-plugin/scripts/subagent-start-marker.js` only emits the marker through `hookSpecificOutput.additionalContext`
- the final `<system-reminder>` wrapper is added by Claude Code runtime during `SubagentStart`
- the current parser in `src/routes/messages/subagent-marker.ts` still slices from `__SUBAGENT_MARKER__` to the end of the reminder block, so any runtime text appended after the JSON payload causes `JSON.parse` to fail

I’m going to fix this in the server-side parser rather than in the plugin:

1. extract only the first complete JSON object immediately after `__SUBAGENT_MARKER__`
2. ignore trailing runtime text in the same `<system-reminder>` block
3. add regression tests for the Claude-style `SubagentStart hook additional context: ...` wrapper with trailing runtime lines

I’ll keep the scope narrow and avoid claiming broader downstream effects beyond the parser/subagent semantics that are directly observable in the current code.
EOF
)"
```
Expected: GitHub CLI returns the new comment URL or confirms the comment was created.

---

## Task 2: Add failing regression coverage for trailing runtime text

Write tests that pin the current bug before changing the parser.

**Files:**
- Modify: `tests/subagent-marker.test.ts`
- Test: `tests/subagent-marker.test.ts`

- [ ] **Step 1: Add a reusable helper for wrapped marker text in the test file**

```ts
const wrapMarker = (markerBody: string) => `<system-reminder>
SubagentStart hook additional context: ${markerBody}
</system-reminder>`
```

- [ ] **Step 2: Add the new failing regression test for one trailing runtime line**

```ts
test("parses marker when runtime text follows the JSON payload", () => {
  const payload = basePayload([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<system-reminder>
SubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"s-3","agent_id":"a-3","agent_type":"pr-review-toolkit:code-reviewer"}
Agent pr-review-toolkit:code-reviewer started (a-3)
</system-reminder>`,
        },
      ],
    },
  ])

  expect(parseSubagentMarkerFromFirstUser(payload)).toEqual({
    session_id: "s-3",
    agent_id: "a-3",
    agent_type: "pr-review-toolkit:code-reviewer",
  })
})
```

- [ ] **Step 3: Add the new regression test for multiple trailing lines**

```ts
test("parses marker when multiple runtime lines follow the JSON payload", () => {
  const payload = basePayload([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<system-reminder>
SubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"s-4","agent_id":"a-4","agent_type":"Explore"}
Agent Explore started (a-4)
Waiting for tool approval
</system-reminder>`,
        },
      ],
    },
  ])

  expect(parseSubagentMarkerFromFirstUser(payload)).toEqual({
    session_id: "s-4",
    agent_id: "a-4",
    agent_type: "Explore",
  })
})
```

- [ ] **Step 4: Add the negative test for an unterminated JSON object**

```ts
test("returns null when marker JSON object is incomplete", () => {
  const payload = basePayload([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<system-reminder>
SubagentStart hook additional context: __SUBAGENT_MARKER__{"session_id":"s-5","agent_id":"a-5"
Agent Explore started (a-5)
</system-reminder>`,
        },
      ],
    },
  ])

  expect(parseSubagentMarkerFromFirstUser(payload)).toBeNull()
})
```

- [ ] **Step 5: Run the targeted test file and verify the new regression fails before the implementation change**

Run:
```bash
bun test "tests/subagent-marker.test.ts"
```
Expected: the new trailing-text regression tests fail while the existing tests continue to pass.

---

## Task 3: Implement the minimal parser fix in `subagent-marker.ts`

Extract only the first balanced JSON object after the marker prefix and preserve current null-on-invalid behavior.

**Files:**
- Modify: `src/routes/messages/subagent-marker.ts`
- Test: `tests/subagent-marker.test.ts`

- [ ] **Step 1: Add a helper that extracts the first balanced JSON object**

```ts
const extractFirstJsonObject = (text: string): string | null => {
  const objectStart = text.indexOf("{")
  if (objectStart === -1) {
    return null
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = objectStart; index < text.length; index++) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === "\\") {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === "{") {
      depth++
      continue
    }

    if (char === "}") {
      depth--
      if (depth === 0) {
        return text.slice(objectStart, index + 1)
      }
    }
  }

  return null
}
```

- [ ] **Step 2: Replace the current tail parse with helper-based extraction**

```ts
const markerTail = reminderContent.slice(
  markerIndex + subagentMarkerPrefix.length,
)
const markerJson = extractFirstJsonObject(markerTail)

if (!markerJson) {
  searchFrom = reminderEnd + endTag.length
  continue
}

try {
  const parsed = JSON.parse(markerJson) as SubagentMarker
  if (!parsed.session_id || !parsed.agent_id || !parsed.agent_type) {
    searchFrom = reminderEnd + endTag.length
    continue
  }

  return parsed
} catch {
  searchFrom = reminderEnd + endTag.length
  continue
}
```

- [ ] **Step 3: Keep the helper private to this module and preserve the current API surface**

```ts
export const parseSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
): SubagentMarker | null => {
  // unchanged public entrypoint
}
```

- [ ] **Step 4: Run the targeted test file and verify it now passes**

Run:
```bash
bun test "tests/subagent-marker.test.ts"
```
Expected: all tests in `tests/subagent-marker.test.ts` pass.

---

## Task 4: Run adjacent verification for subagent semantics

Check that the parser change did not break the downstream handler-level expectations that rely on successful marker detection.

**Files:**
- Modify: None
- Test: `tests/messages-handler.test.ts`
- Test: `tests/messages-request-log-subagent.test.ts`

- [ ] **Step 1: Run the request-log subagent test file**

Run:
```bash
bun test "tests/messages-request-log-subagent.test.ts"
```
Expected: PASS, including the request-log path that depends on `isSubagent` markers.

- [ ] **Step 2: Run the messages handler test file**

Run:
```bash
bun test "tests/messages-handler.test.ts"
```
Expected: PASS, including existing subagent marker handling expectations.

- [ ] **Step 3: Review the final diff for scope control**

Verify the diff only changes:

```text
src/routes/messages/subagent-marker.ts
tests/subagent-marker.test.ts
```

Expected: no plugin files, no unrelated request-flow files, no docs outside the already-written spec/plan files.

---

## Self-Review Checklist

- Spec coverage: the plan covers issue reply, parser fix, regression tests, and verification without expanding into plugin changes.
- Placeholder scan: all steps include exact files, commands, and code snippets.
- Type consistency: the parser entrypoint remains `parseSubagentMarkerFromFirstUser`, and the new helper stays private to `subagent-marker.ts`.
