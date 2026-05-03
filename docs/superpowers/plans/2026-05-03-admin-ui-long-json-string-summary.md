# Admin UI Long JSON String Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent very long string fields in the request detail Raw JSON viewer from pushing later fields far down the page while preserving full-value inspection and copy affordances.

**Architecture:** Add a focused long-string summary path inside `JsonViewer` so any string over a fixed threshold renders as compact metadata plus preview instead of the full inline value. Keep the behavior generic to avoid hard-coding `responses_item_owner_lookup_keys_json`, and use existing i18n plus UI button patterns.

**Tech Stack:** React 19, TypeScript, Bun test runner, `react-dom/server` component tests, existing shadcn-style UI primitives.

---

## File Structure

- Modify `admin-ui/src/components/json/json-viewer.tsx`
  - Add constants for long string threshold and preview size.
  - Add pure helpers to summarize long strings.
  - Render long strings as compact summaries with preview and copy affordance.
- Modify `admin-ui/src/locales/en-US.json`
  - Add `jsonViewer.longString*` labels.
- Modify `admin-ui/src/locales/zh-CN.json`
  - Add Chinese labels for the same keys.
- Create `admin-ui/tests/json-viewer-long-string.test.tsx`
  - Static-render tests for long-string summary behavior and normal-string unchanged behavior.

## Task 1: Add failing long-string viewer tests

**Files:**
- Create: `admin-ui/tests/json-viewer-long-string.test.tsx`
- Test target: `admin-ui/src/components/json/json-viewer.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { JsonViewer } from "../src/components/json/json-viewer"

test("JsonViewer summarizes very long string values", () => {
  const longValue = "lookup-key-".repeat(500)

  const html = renderToStaticMarkup(
    <JsonViewer
      value={{ responses_item_owner_lookup_keys_json: longValue, next_field: "visible" }}
    />,
  )

  expect(html).toContain("responses_item_owner_lookup_keys_json")
  expect(html).toContain("Long string")
  expect(html).toContain("5,500 chars")
  expect(html).toContain("lookup-key-lookup-key")
  expect(html).toContain("View full")
  expect(html).toContain("Copy")
  expect(html).toContain("next_field")
  expect(html.length).toBeLessThan(longValue.length)
})

test("JsonViewer keeps short string values inline", () => {
  const html = renderToStaticMarkup(
    <JsonViewer value={{ short_field: "short value" }} />,
  )

  expect(html).toContain("short_field")
  expect(html).toContain("&quot;short value&quot;")
  expect(html).not.toContain("Long string")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/json-viewer-long-string.test.tsx
```

Expected: FAIL because the current `JsonViewer` renders the full long string inline and does not contain `Long string`, `View full`, or `Copy`.

## Task 2: Implement compact long-string summaries

**Files:**
- Modify: `admin-ui/src/components/json/json-viewer.tsx`
- Modify: `admin-ui/src/locales/en-US.json`
- Modify: `admin-ui/src/locales/zh-CN.json`
- Test: `admin-ui/tests/json-viewer-long-string.test.tsx`

- [ ] **Step 1: Add i18n labels**

Add under `jsonViewer` in `admin-ui/src/locales/en-US.json`:

```json
"longStringLabel": "Long string",
"longStringChars": "{{count}} chars",
"longStringPreview": "Preview",
"longStringViewFull": "View full",
"longStringCopy": "Copy",
"longStringSearchMatch": "Search matches inside this long value"
```

Add under `jsonViewer` in `admin-ui/src/locales/zh-CN.json`:

```json
"longStringLabel": "长字符串",
"longStringChars": "{{count}} 个字符",
"longStringPreview": "预览",
"longStringViewFull": "查看完整",
"longStringCopy": "复制",
"longStringSearchMatch": "搜索命中该长值内部内容"
```

- [ ] **Step 2: Implement minimal summary rendering**

In `admin-ui/src/components/json/json-viewer.tsx`:

```tsx
const LONG_STRING_THRESHOLD = 2000
const LONG_STRING_PREVIEW_LENGTH = 240

function formatCount(count: number): string {
  return new Intl.NumberFormat().format(count)
}

function getLongStringPreview(value: string): string {
  if (value.length <= LONG_STRING_PREVIEW_LENGTH) return value
  return `${value.slice(0, LONG_STRING_PREVIEW_LENGTH - 1)}…`
}
```

Change `formatPrimitive` so strings longer than `LONG_STRING_THRESHOLD` render a compact block containing label, char count, preview, `View full`, and `Copy`. Short strings keep the existing inline rendering.

- [ ] **Step 3: Run targeted test**

Run:

```bash
bun test tests/json-viewer-long-string.test.tsx
```

Expected: PASS.

## Task 3: Add full-value inspection and search hint behavior

**Files:**
- Modify: `admin-ui/src/components/json/json-viewer.tsx`
- Test: `admin-ui/tests/json-viewer-long-string.test.tsx`

- [ ] **Step 1: Add tests for search hint**

Append this test:

```tsx
test("JsonViewer indicates search matches inside summarized long strings", () => {
  const longValue = `${"prefix-".repeat(400)}needle-${"suffix-".repeat(400)}`

  const html = renderToStaticMarkup(
    <JsonViewer value={{ long_field: longValue }} search="needle" />,
  )

  expect(html).toContain("Search matches inside this long value")
})
```

Run:

```bash
bun test tests/json-viewer-long-string.test.tsx
```

Expected: FAIL until search-match hint is implemented.

- [ ] **Step 2: Implement search hint**

When a summarized long string contains the active search query, render `t("jsonViewer.longStringSearchMatch")` in muted text below the preview.

- [ ] **Step 3: Run targeted test**

Run:

```bash
bun test tests/json-viewer-long-string.test.tsx
```

Expected: PASS.

## Task 4: Verify integration quality

**Files:**
- Verify: `admin-ui/src/components/json/json-viewer.tsx`
- Verify: `admin-ui/src/locales/en-US.json`
- Verify: `admin-ui/src/locales/zh-CN.json`
- Verify: `admin-ui/tests/json-viewer-long-string.test.tsx`

- [ ] **Step 1: Run owner-key regression test**

```bash
bun test tests/request-detail-ownership.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run JsonViewer test**

```bash
bun test tests/json-viewer-long-string.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run admin-ui typecheck**

```bash
bunx tsc --noEmit -p tsconfig.app.json --ignoreDeprecations 5.0
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Review diff**

Check that no unrelated files changed, the long-string behavior is generic, and no full 13k string is rendered in static output.

## Self-Review

- Spec coverage: The plan covers compact rendering, full-value affordances, copy affordance, search-match hint, i18n, and tests.
- Placeholder scan: No placeholder implementation steps remain.
- Type consistency: All referenced files, components, and locale keys match the existing code structure.

## Execution Notes

Do not create a git commit unless explicitly requested by the user. This differs from the generic skill template because the repository instructions require explicit user authorization before commits.
