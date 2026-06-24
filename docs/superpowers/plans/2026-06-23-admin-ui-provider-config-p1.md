# P1 Implementation Plan: Admin-UI Quick Providers and Token Usage Basics

Date: 2026-06-23
Branch: all
Scope: P1 only, after P0 Admin-UI provider config contract is green

## Goal

P1 makes two merged backend capabilities visible in Admin-UI without expanding into a full dashboard rewrite:

1. Quick-add common upstream providers from Settings.
2. Show token usage summary, daily rows, and recent events in a dedicated Admin-UI page.

The priority remains configuration safety and semantic clarity. Token Usage must stay distinct from existing AI Credits statistics.

## Non-goals

- Do not reintroduce Electron UI or desktop assets.
- Do not implement P2 aggregated `/v1/models` preview.
- Do not replace the existing Statistics page.
- Do not build complex charts, export, forecasting, or multi-currency analytics.
- Do not add automatic provider pricing sync.
- Do not extend config-layer `modelReasoningEfforts` to `max`.
- Do not create commits or push changes.

## Current facts

- Admin-UI routes are defined in `admin-ui/src/App.tsx`.
- Admin-UI navigation items are defined in `admin-ui/src/components/app-shell.tsx`.
- Admin API client helpers live in `admin-ui/src/lib/admin-api.ts` and use `fetchAdminJson<T>()` with `x-admin-token`.
- Token usage backend exists at:
  - `GET /token-usage?period=day|week|month`
  - `GET /token-usage/daily?period=day|week|month`
  - `GET /token-usage/events?period=day|week|month&page=1&page_size=20`
- The current Vite dev proxy only proxies `/api/admin`, so Admin-UI should not directly depend on unauthenticated `/token-usage` paths for P1.
- Settings provider state already has P0-safe round-trip for provider type, auth type, pricing currency, and provider model advanced fields.

## Design choices

### Token Usage Admin path

Add Admin API aliases for token usage under `/api/admin/token-usage` rather than calling `/token-usage` directly from Admin-UI.

Why:

- Reuses the existing Admin-UI `fetchAdminJson<T>()` and `x-admin-token` behavior.
- Reuses the existing Vite proxy for `/api/admin`.
- Keeps Admin-UI data access consistent with other admin pages.
- Avoids leaking an assumption that public API auth and Admin UI auth are the same.

Implementation should delegate to the same backend token usage library functions as `src/routes/token-usage/route.ts`; do not duplicate storage logic.

### Quick providers

Implement quick add in Settings Providers as safe templates:

- DeepSeek
- DashScope
- OpenRouter
- Custom

Defaults must match backend quick provider config in `src/lib/quick-providers.ts` where applicable:

- `deepseek`: `type: "anthropic"`, `baseUrl: "https://api.deepseek.com/anthropic"`, `pricingCurrency: "CNY"`
- `dashscope`: `type: "openai-compatible"`, `baseUrl: "https://dashscope.aliyuncs.com/compatible-mode"`, `pricingCurrency: "CNY"`
- `openrouter`: `type: "anthropic"`, `baseUrl: "https://openrouter.ai/api"`, `pricingCurrency: "USD"`
- `custom`: blank provider row with existing defaults

For all quick providers:

- `enabled: true`
- `authType: "x-api-key"`
- `apiKey: ""`
- `adjustInputTokens: false`
- `models: []`

If a provider key already exists, generate a unique suffix such as `deepseek-2` rather than overwriting existing config.

## Implementation tasks

### Task 1: Add Admin token-usage API aliases

Files:

- `src/routes/admin-api/route.ts`
- `tests/admin-config.test.ts` or a new focused backend test if the existing file becomes too broad

Steps:

1. Import token usage functions/types from `~/lib/token-usage`:
   - `getTokenUsageSummary`
   - `getTokenUsageDailySummary`
   - `getTokenUsageEventsPage`
   - `type TokenUsagePeriod`
2. Add small parsers near existing Admin API helpers:
   - `parseTokenUsagePeriod(value)` with allowed `day | week | month`, default `day`.
   - `parsePositiveInt(value, fallback)` for `page` and `page_size`.
3. Add routes under Admin API:
   - `GET /token-usage`
   - `GET /token-usage/daily`
   - `GET /token-usage/events`
4. Each route should call the same token usage library function as the public route and return `c.json(...)`.
5. Keep behavior simple: invalid period falls back to `day`, invalid page/page_size falls back to defaults, matching public route behavior.

Tests:

- Verify Admin API token usage summary route returns JSON from the token usage store.
- Verify daily route returns JSON.
- Verify events route accepts `period`, `page`, and `page_size`.
- Prefer lightweight assertions on shape and status, not brittle full DB snapshots.

### Task 2: Add Admin-UI token usage API client helpers

File:

- `admin-ui/src/lib/admin-api.ts`

Steps:

1. Add types mirroring backend response shapes:
   - `TokenUsagePeriod`
   - `TokenUsageSource`
   - `TokenUsageEndpoint`
   - `TokenUsageCost`
   - `TokenUsageTotals`
   - `TokenUsageModelSummary`
   - `TokenUsageEventRecord`
   - `TokenUsageSummary`
   - `TokenUsageDailySummary`
   - `TokenUsageEventsPage`
2. Add helpers:
   - `getTokenUsageSummary({ period })`
   - `getTokenUsageDaily({ period })`
   - `getTokenUsageEvents({ period, page, pageSize })`
3. Use `/api/admin/token-usage` paths.
4. Use `URLSearchParams` and `page_size` query naming, matching project style.
5. Do not normalize null cost/token fields to zero. Preserve backend values.

Tests:

- Add or extend Admin-UI API tests to verify helper URL construction if fetch mocking is already practical.
- If fetch mocking is not existing, rely on TypeScript plus page-level static render for P1.

### Task 3: Add Token Usage page and navigation

Files:

- `admin-ui/src/pages/token-usage-page.tsx` (new)
- `admin-ui/src/App.tsx`
- `admin-ui/src/components/app-shell.tsx`
- `admin-ui/src/locales/en-US.json`
- `admin-ui/src/locales/zh-CN.json`

Page requirements:

1. Dedicated route: `/token-usage`.
2. Dedicated nav item, separate from `Statistics`.
3. Period selector:
   - `day`
   - `week`
   - `month`
4. Summary cards/table:
   - total input tokens
   - output tokens
   - cache read tokens
   - cache creation tokens
   - total tokens
   - cost by currency when provided
5. Daily table:
   - date
   - source
   - input/output/cache/total tokens
   - cost/currency if provided
6. Recent events table:
   - time
   - source
   - endpoint
   - provider
   - model
   - input/output/cache/total tokens
   - cost/currency
   - trace/session id if available
7. Events pagination:
   - use `page` and `page_size`.
   - P1 may implement Previous/Next or Load More; choose the simpler approach consistent with current state.
8. Loading/error/empty states:
   - initial loading skeleton or muted placeholder.
   - InlineAlert retry on load failure.
   - clear empty state when there is no token usage.
9. Semantics:
   - Use “Token Usage” and provider cost wording.
   - Do not label provider token usage as “AI Credits”.

Keep UI simple. Tables and basic cards are enough; no chart requirement in P1.

### Task 4: Add Quick Add provider controls

File:

- `admin-ui/src/pages/settings-page.tsx`
- `admin-ui/src/locales/en-US.json`
- `admin-ui/src/locales/zh-CN.json`
- optionally `admin-ui/tests/settings-page.test.tsx`

Steps:

1. Add a small frontend quick provider constant or helper near provider constants.
2. Define quick provider names:
   - `deepseek`
   - `dashscope`
   - `openrouter`
   - `custom`
3. Add a pure helper to create provider items from presets:
   - `createProviderItem(overrides?)`
   - `createQuickProviderItem(name, existingItems)`
   - `getUniqueProviderName(baseName, existingItems)`
4. Extend `ProvidersEditor` with `onQuickAddProvider(name)`.
5. Keep existing `onAddProvider()` behavior as blank custom row.
6. Add compact controls in `ProvidersSettingsCard` near the Add Provider button:
   - a quick-add select or small button group.
   - labels should be localized.
7. Prevent overwrite:
   - If `deepseek` exists, new one becomes `deepseek-2`, then `deepseek-3`, etc.
8. OpenRouter type should default to `anthropic`; P1 can show a note that it mirrors backend quick-provider defaults, but does not need to lock editing.

- Do not add or map backend `editableType` semantics in P1. Admin-UI quick add only copies safe defaults (`type`, `baseUrl`, `pricingCurrency`) and keeps the resulting provider row editable like other Settings rows.
Tests:

- Test pure helper unique-name behavior.
- Test each quick preset maps to expected type/baseUrl/pricingCurrency/authType.
- If Settings render tests are already simple to extend, verify quick provider labels render.

### Task 5: Verification

Run at minimum:

```bash
bun test tests/token-usage.test.ts
bun test tests/admin-config.test.ts
bun test admin-ui/tests/settings-page.test.tsx
bun run typecheck
bun run typecheck:admin
bun run build:admin
bun run lint:admin
git diff --check
```

Also run a conflict-marker scan excluding generated/dependency directories:

```bash
python3 - <<'PY'
from pathlib import Path
root = Path('.')
targets = [root / 'src', root / 'admin-ui', root / 'tests', root / 'docs']
skip_dirs = {'node_modules', 'dist', '.git'}
found = []
for base in targets:
    if not base.exists():
        continue
    for path in base.rglob('*'):
        if any(part in skip_dirs for part in path.parts):
            continue
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        for index, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if line.startswith('<<<<<<< ') or stripped == '=======' or line.startswith('>>>>>>> '):
                found.append(f'{path}:{index}:{line}')
if found:
    print('\n'.join(found))
    raise SystemExit(1)
PY
```

After implementation, request an independent review focused on:

- Token Usage not conflated with AI Credits.
- Admin-UI uses `/api/admin/token-usage` aliases consistently.
- Quick provider defaults match backend quick-provider constants.
- Existing Settings provider round-trip safety is not regressed.

## Success criteria

P1 is done when:

- Settings Providers can quick-add DeepSeek, DashScope, OpenRouter, and Custom provider rows.
- Quick-add never overwrites an existing provider entry.
- Token Usage has a dedicated Admin-UI nav item and route.
- Token Usage page can load summary, daily data, and recent events from Admin API aliases.
- Loading, empty, and error states are visible and recoverable.
- Provider token usage cost is not labeled as AI Credits.
- All verification commands pass, except allowed non-failing Vite chunk size warnings.
- Independent reviewer reports no blocking findings.
