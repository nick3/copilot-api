# P2 Implementation Plan: Admin-UI Aggregated Models Preview and Web Search Model UX

Date: 2026-06-23
Branch: all
Scope: P2 only, after P1 Quick Providers and Token Usage basics are green

## Goal

P2 makes two remaining merged runtime capabilities easier to understand from Admin-UI without changing the core configuration model:

1. Add a read-only aggregated models preview to the existing Models page.
2. Improve `messageApiWebSearchModel` UX in Settings with clearer guidance and safe suggestions.

The priority is semantic clarity. Admin models/details remains the management-oriented model metadata view; aggregated `/v1/models` preview is a runtime client-facing catalog preview.

## Non-goals

- Do not reintroduce Electron UI or desktop assets.
- Do not replace the existing Models page or its `/api/admin/models/details` table.
- Do not make aggregated preview editable.
- Do not implement provider remote dynamic discovery in P2.
- Do not add automatic provider model sync.
- Do not add complex model catalog management, provider health checks, or cache refresh workflows.
- Do not turn `messageApiWebSearchModel` suggestions into validation; custom values and empty values remain allowed.
- Do not extend config-layer `modelReasoningEfforts` to `max`.
- Do not create commits or push changes.

## Current facts

- Admin-UI route `/models` renders `admin-ui/src/pages/models-page.tsx`.
- Current Models page loads `getAdminModelDetails()` from `/api/admin/models/details` and shows model metadata from the first Copilot account cache.
- Public `/v1/models` is implemented by `src/routes/models/route.ts` and returns OpenAI-compatible list shape:
  - `object: "list"`
  - `data: Array<{ id, object, type, created, created_at, owned_by, display_name, claude_model_id }>`
  - `has_more: false`
- Public `/v1/models` combines:
  - available Copilot models from `getAvailableModels()`
  - model aliases from `getModelAliases()`
  - enabled provider models from `listEnabledProviders()` / `forwardProviderModels()`
  - built-in Codex provider models without remote fetch
  - de-duplicates by `id`, Copilot and aliases before provider models
- `getAvailableModels()` currently uses `accountsManager.getFirstAccountModels()`.
- Public `/v1/models` already performs provider model aggregation for enabled providers. P2 must not add a new provider discovery mechanism, sync workflow, cache refresh UI, or automatic provider model import. The Admin preview should either mirror this existing runtime aggregation exactly or explicitly document and test any narrower scope.
- Existing Admin API `/api/admin/models` returns only `{ items: string[] }` from first account models plus aliases.
- Existing Admin API `/api/admin/models/details` returns rich management metadata but not the exact client-facing `/v1/models` shape.
- Settings `messageApiWebSearchModel` is currently a free-text input. It already loads `models: string[]` via `getAdminModels()` and has provider config state available in Settings.

## Design choices

### Aggregated models Admin alias

Add a new Admin API alias for the aggregated runtime model catalog, rather than having Admin-UI call public `/v1/models` directly.

Recommended route:

- `GET /api/admin/models/aggregated`

Why:

- Keeps Admin-UI on the existing `fetchAdminJson<T>()` + `x-admin-token` path.
- Avoids mixing Admin token and public API auth assumptions.
- Makes the runtime preview explicit and easy to test.
- Lets the backend reuse the same aggregation logic as public `/v1/models` without duplicating route-only code.

Implementation detail:

- Extract the aggregation from `src/routes/models/route.ts` into a small exported function, for example `getAggregatedModelsResponse()`.
- Public `modelRoutes.get("/")` calls that function.
- Admin API `GET /models/aggregated` calls the same function.
- Do not change the public `/v1/models` response shape.

### Models page UX

Add a read-only preview section/card in `admin-ui/src/pages/models-page.tsx`.

Recommended P2 UX:

- Keep the current management table as-is.
- Add a separate card below or above the existing table titled “Aggregated /v1/models preview”.
- Include clear copy that it is runtime client-facing and read-only.
- Show a simple table:
  - client model id (`id`)
  - display name
  - owned by
  - Claude model id (`claude_model_id`)
  - source classification (`copilot`, `alias`, or `unknown`) if derivable without changing backend shape too much
- P2 can avoid source classification if doing so would require changing public shape. If source is shown, prefer deriving in Admin UI by comparing with current `/api/admin/models/details` ids and aliases, not by changing `/v1/models` public payload.
- Loading/error/empty states must be visible and recoverable.

### Web search model UX

Improve the existing `messageApiWebSearchModel` field without narrowing valid input.

Recommended P2 UX:

- Keep free-text input.
- Add lightweight suggestions visible in SSR/static render-friendly markup:
  - Copilot model suggestions from existing `models: string[]`.
  - Configured provider model suggestions derived from current Settings providers: `providerName/modelName`.
- Suggestions are buttons or chips that fill the input when clicked.
- Keep custom values allowed.
- Keep empty value allowed and documented as disabled.
- Improve hint text to clarify:
  - plain Copilot model → Copilot Responses web search path
  - `provider/model` → provider Messages passthrough
  - suggestions are candidates, not validation

Do not add provider remote model discovery. Provider suggestions are only from models already configured in Settings.

## Implementation tasks

### Task 1: Add shared aggregated models helper and Admin alias

Files:

- `src/routes/models/route.ts`
- `src/routes/admin-api/route.ts`
- `tests/admin-models-details.test.ts` or a new focused backend test

Steps:

1. Extract current `/v1/models` response construction into an exported function, e.g. `getAggregatedModelsResponse()`.
2. Keep `modelRoutes.get("/")` behavior identical by returning `c.json(getAggregatedModelsResponse())`.
3. Import the helper in `src/routes/admin-api/route.ts`.
4. Add `GET /models/aggregated` under Admin API.
5. Return the same shape as public `/v1/models`.
6. Do not include provider remote discovery or mutable fields.

Tests:

- Verify public `/v1/models` still returns expected list shape.
- Verify `GET /api/admin/models/aggregated` returns the same shape.
- Verify aliases appear in the aggregated response.
- Verify real model ids win over alias ids when duplicated, matching existing behavior if covered already.
- Verify Admin `/api/admin/models/aggregated` mirrors public runtime aggregation for enabled provider models, including provider-prefixed ids such as `provider/model`.
- Verify failed provider model fetches do not break the Admin aggregated preview, matching public `/v1/models` skip-on-error behavior.
- Verify built-in Codex provider models can appear without remote fetch when Codex is enabled.

### Task 2: Add Admin-UI API client types and helper

File:

- `admin-ui/src/lib/admin-api.ts`

Steps:

1. Add types matching aggregated response:
   - `AggregatedModelItem`
   - `AggregatedModelsResponse`
2. Add helper:
   - `getAdminAggregatedModels()` → `/api/admin/models/aggregated`
3. Preserve existing `getAdminModels()` and `getAdminModelDetails()` semantics.

Tests:

- If fetch mocking is already available, add URL construction test.
- Otherwise rely on TypeScript and page/static render tests for P2.

### Task 3: Add read-only aggregated preview to Models page

File:

- `admin-ui/src/pages/models-page.tsx`
- `admin-ui/src/locales/en-US.json`
- `admin-ui/src/locales/zh-CN.json`
- optionally `admin-ui/tests/models-page.test.tsx`

Steps:

1. Load aggregated preview via `getAdminAggregatedModels()` alongside or after `getAdminModelDetails()`.
2. Keep failures scoped: failing aggregated preview should not break the main management table.
3. Add a dedicated read-only card/table.
4. Add loading/empty/error state with Retry.
5. Do not make any aggregated row editable.
6. Clearly label this as `/v1/models` runtime preview.
7. Avoid claiming it is all-account discovery or a new provider discovery feature; it mirrors the backend runtime aggregation already used by public `/v1/models`, including any enabled-provider model aggregation that route already performs.

Tests:

- Add a small static render test if the page can be rendered without browser-only APIs.
- At minimum, test pure helper/source classifier if one is introduced.
- Verify locale keys render terms like “read-only” and “/v1/models”.

### Task 4: Improve `messageApiWebSearchModel` UX

File:

- `admin-ui/src/pages/settings-page.tsx`
- `admin-ui/src/locales/en-US.json`
- `admin-ui/src/locales/zh-CN.json`
- `admin-ui/tests/settings-page.test.tsx`

Steps:

1. Add a pure helper to derive provider/model suggestions from provider editor items.
2. Pass configured provider model suggestions into `ResponsesApiSettingsCard`.
3. Keep existing free-text input.
4. Render candidate chips/buttons:
   - Copilot model suggestions from existing `models` prop.
   - Provider model suggestions from configured provider models.
5. Keep suggestions bounded for readability, e.g. first 6 Copilot and first 6 provider suggestions.
6. If current value is custom and not in suggestions, display it as a custom value note rather than rejecting it.
7. Update hint text to explain plain model vs `provider/model` behavior.

Tests:

- Existing empty-value test must keep passing.
- Add helper test for provider/model suggestion derivation.
- Add render test that a Copilot suggestion and provider/model suggestion appear.
- Add render test that custom value remains visible/accepted.

### Task 5: Verification

Run at minimum:

```bash
bun test tests/admin-models-details.test.ts
bun test admin-ui/tests/settings-page.test.tsx
bun run typecheck
bun run typecheck:admin
bun run build:admin
bun run lint:admin
git diff --check
```

If a new models page test is added, run it directly as well:

```bash
bun test admin-ui/tests/models-page.test.tsx
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

- Aggregated preview remains read-only and distinct from Admin model management.
- Admin-UI uses `/api/admin/models/aggregated`, not public `/v1/models`.
- No provider remote dynamic discovery slipped into P2.
- `messageApiWebSearchModel` still allows empty and custom values.
- Settings provider round-trip safety from P0/P1 is not regressed.

## Success criteria

P2 is done when:

- Models page keeps the existing management table intact.
- Models page shows a read-only aggregated `/v1/models` runtime preview.
- Admin-UI loads aggregated preview through Admin API.
- Aggregated preview uses the same backend aggregation logic as public `/v1/models`, including existing enabled-provider aggregation behavior without adding new provider discovery/sync mechanisms.
- Settings `messageApiWebSearchModel` UX explains plain model vs `provider/model` behavior.
- Settings offers safe Copilot and configured provider/model suggestions without enforcing them.
- Empty/custom `messageApiWebSearchModel` values remain valid.
- All verification commands pass, except allowed non-failing Vite chunk size warnings.
- Independent reviewer reports no blocking findings.
