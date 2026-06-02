# Issue #56 Subagent Marker Parser Fix — Design Spec

**Date**: 2026-04-09
**Status**: Draft
**Scope**: Fix parsing of `__SUBAGENT_MARKER__` when Claude Code wraps hook output in `<system-reminder>` and appends runtime text after the JSON payload

## Overview

Issue #56 reports that `parseSubagentMarkerFromSystemReminder` fails when `__SUBAGENT_MARKER__{...}` is followed by extra text before `</system-reminder>`. The current parser slices from the marker prefix to the end of the reminder block and passes the entire tail to `JSON.parse`, which returns `null` once runtime text is appended.

The Claude plugin in this repository does not generate the full `<system-reminder>` payload itself. `claude-plugin/scripts/subagent-start-marker.js` only emits `hookSpecificOutput.additionalContext`, and Claude Code is responsible for wrapping that content into a `<system-reminder>` block during `SubagentStart`. Because the runtime wrapper may append additional human-readable lines, the safest and smallest fix belongs in the server-side parser, not in the plugin.

## Confirmed Inputs and Boundaries

### Confirmed producer boundary

- `claude-plugin/scripts/subagent-start-marker.js` emits only the marker payload through `hookSpecificOutput.additionalContext`
- `claude-plugin/hooks/hooks.json` attaches that script to the `SubagentStart` hook
- `.opencode/plugins/subagent-marker.js` constructs its own `<system-reminder>` text, but does not append extra text after the JSON marker in the current implementation

### Confirmed parser boundary

The server currently accepts these marker shapes:

1. Bare marker inside `<system-reminder>`
2. `SubagentStart hook additional context: __SUBAGENT_MARKER__{...}` inside `<system-reminder>`

The server currently fails on this additional compatible shape:

3. `SubagentStart hook additional context: __SUBAGENT_MARKER__{...}` followed by one or more additional runtime lines before `</system-reminder>`

## Requirements

### Functional

1. The parser must extract exactly the first complete JSON object immediately following `__SUBAGENT_MARKER__`
2. The parser must ignore trailing runtime text after that JSON object within the same `<system-reminder>` block
3. Existing supported inputs must continue to parse successfully
4. Invalid JSON and missing required fields must still return `null`

### Non-functional

1. Keep the fix localized to the parser and tests
2. Do not change the Claude plugin contract for `additionalContext`
3. Do not broaden the parser to unrelated reminder formats
4. Preserve existing behavior for non-subagent requests

## Options Considered

### Option A — Parser extracts the first complete JSON object (Recommended)

Update `src/routes/messages/subagent-marker.ts` so that after finding `__SUBAGENT_MARKER__`, it scans forward and captures the first balanced JSON object, then parses only that substring.

**Pros**
- Fixes the reported issue directly
- Matches the confirmed producer/runtime boundary
- Preserves plugin behavior and existing request shapes
- Keeps blast radius small

**Cons**
- Slightly more logic than a newline split
- Needs careful tests for object extraction

### Option B — Split at the first newline

Parse only the first line after the marker.

**Pros**
- Smallest code change

**Cons**
- Too dependent on current line formatting
- More brittle if runtime formatting changes
- Less semantically correct than extracting the JSON object itself

### Option C — Change the plugin output format too

Modify plugin output and parser behavior together.

**Pros**
- Could create a tighter contract in theory

**Cons**
- Plugin does not control final runtime wrapping
- Unnecessary scope increase for this issue
- Higher regression surface

## Recommended Approach

Use **Option A**.

Implement a small helper in `src/routes/messages/subagent-marker.ts` that starts at the first `{` after `__SUBAGENT_MARKER__`, walks the string, tracks brace depth, and returns the substring for the first complete JSON object. Then `JSON.parse` only that substring.

This keeps the parser aligned with the actual contract: the marker payload is a JSON object prefix embedded inside a larger runtime-generated reminder block.

## Out of Scope

The fix will **not**:

- change `claude-plugin/scripts/subagent-start-marker.js`
- change Claude Code runtime hook formatting
- attempt to prove broader quota/account-selection impact beyond what current code directly shows
- redesign all `<system-reminder>` parsing logic

## Implementation Design

### Parser change

Target file: `src/routes/messages/subagent-marker.ts`

1. Keep the existing loop over `<system-reminder>` blocks
2. Keep the existing search for `__SUBAGENT_MARKER__`
3. Replace the current `.slice(...).trim()` tail parse with:
   - find the first `{` after the marker prefix
   - scan characters while tracking object depth
   - stop once the first top-level JSON object closes
   - if no complete object is found, continue scanning later reminder blocks
4. Parse the extracted JSON object and preserve existing required-field checks

### Test change

Target file: `tests/subagent-marker.test.ts`

Add coverage for:

1. Existing prefixed marker still parses
2. Prefixed marker plus trailing runtime line parses successfully
3. Prefixed marker plus multiple trailing lines parses successfully
4. Truncated or unterminated JSON object still returns `null`

Keep the current negative tests for invalid JSON and missing fields.

## Issue Reply Plan

The issue reply should be conservative and accurate:

1. Acknowledge that the parser bug is valid and reproducible in current code
2. Clarify that the repository’s Claude plugin emits marker content through `additionalContext`, while the final `<system-reminder>` wrapper is added by Claude Code runtime
3. State that the fix will be implemented in the server-side parser, not in the plugin
4. State that tests will be added for runtime-appended trailing text
5. Avoid over-claiming downstream effects that are not directly proven by current code

## Verification Plan

Minimum verification before calling the fix complete:

1. Run `bun test tests/subagent-marker.test.ts`
2. Confirm the new trailing-text regression test passes
3. Confirm existing subagent marker tests still pass
4. Optionally run adjacent targeted tests if parser behavior touches downstream request flow

## Risks and Mitigations

### Risk: incorrect brace matching

If the helper extracts the wrong substring, valid markers could still fail.

**Mitigation:**
Keep the extractor focused on the first JSON object only and cover it with targeted tests.

### Risk: accidental broadening of reminder parsing

A too-clever parser could start accepting unintended shapes.

**Mitigation:**
Anchor parsing strictly to `__SUBAGENT_MARKER__` and continue requiring all three fields.

### Risk: overstating impact in the issue reply

The original issue body suggests broader downstream effects that are not fully proven in current code.

**Mitigation:**
Keep the issue reply scoped to parser failure, lost subagent semantics, and the planned fix.

## Acceptance Criteria

1. `parseSubagentMarkerFromFirstUser` returns the expected marker for issue-compatible input with trailing runtime text
2. Existing passing tests in `tests/subagent-marker.test.ts` continue to pass
3. No plugin file changes are required for the fix
4. The issue reply accurately reflects the producer/runtime boundary and the chosen fix
