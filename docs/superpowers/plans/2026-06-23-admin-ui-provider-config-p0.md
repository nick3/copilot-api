# Admin-UI Provider Config P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement P0 of the Admin-UI Provider 与 Token Usage 同步方案: make Admin API and Admin-UI safely accept, preserve, edit, and save the provider configuration fields already supported by the backend config model.

**Design Doc:** `/Users/nick/.gstack/projects/nick3-copilot-api/nick-all-design-20260623-105040.md`

**Architecture:** Contract-first. Backend Admin Config API validation is the source of truth, Admin-UI types mirror that contract, Settings form/json mode must round-trip every supported provider field, and tests prove invalid fields are rejected rather than silently dropped.

**Tech Stack:** Bun, TypeScript, Hono Admin API, React Admin-UI, Vite build, Bun test runner.

---

## Global Constraints

- Do not implement P1/P2 features in this plan: no quick-add provider wizard, no Token Usage page, no aggregated `/v1/models` preview.
- Do not add Electron UI or `desktop/**` changes.
- Do not expand config-layer `modelReasoningEfforts` to `max`; `reasoning_effort: "max"` is request translation layer behavior and not a P0 Settings option.
- Preserve multi-account Copilot architecture and existing Admin-UI structure.
- Do not commit, push, reset, or create branches without explicit user instruction.
- Preserve blocked-key protections for `__proto__`, `constructor`, and `prototype`.
- Keep P0 focused on fields already represented in backend config types: provider `type`, `authType`, `pricingCurrency`, and provider model `extraBody`, `contextCache`, `pricing`, `supportPdf`, `toolContentSupportType`.
- Prefer JSON editor affordances for nested/advanced objects; do not over-formalize tiered pricing into a complex UI in P0.

---

## Current State Summary

- `src/routes/admin-api/route.ts` currently imports `PROVIDER_TYPE_ANTHROPIC` and `applyProviderType()` rejects every provider `type` except `anthropic`.
- `src/routes/admin-api/route.ts` already has `PROVIDER_AUTH_TYPES = ["authorization", "oauth2", "x-api-key"]`, but provider fields do not include `pricingCurrency`.
- `src/routes/admin-api/route.ts` provider model validation currently allows only `temperature`, `topP`, and `topK`.
- `admin-ui/src/lib/admin-api.ts` has `ProviderConfig.authType?: "authorization" | "x-api-key"`, no `oauth2`, no `pricingCurrency`, and no advanced provider model fields.
- `admin-ui/src/pages/settings-page.tsx` has provider form plumbing, but no visible provider type selector, no `oauth2` option, no `pricingCurrency`, and provider model rows only preserve `temperature/topP/topK`.
- `admin-ui/src/pages/settings-page.tsx` already has `REASONING_EFFORTS` without `max`; keep it that way for P0.
- `tests/admin-config.test.ts` covers provider config, duplicate/rejected keys, unsupported provider type rejection, and invalid `authType`; it needs targeted expansion.
- Locale files still contain provider copy that must not claim `anthropic` is the only supported provider.

---

## Task 1: Extend Backend Admin Config Contract

**Files:**
- Modify: `src/routes/admin-api/route.ts`
- Reference only: `src/lib/config.ts`
- Test later: `tests/admin-config.test.ts`

- [ ] **Step 1: Update config imports**

Import the existing provider type helpers from `~/lib/config`:

```ts
isSupportedProviderType
SUPPORTED_PROVIDER_TYPES
type TokenUsagePricingConfig
type TokenUsagePricingTier
type ToolContentSupportType
```

Remove `PROVIDER_TYPE_ANTHROPIC` from this route if it is no longer needed after `applyProviderType()` is generalized.

- [ ] **Step 2: Define Admin API enum constants from backend contract**

Add route-local constants derived from config types where useful:

```ts
const TOOL_CONTENT_SUPPORT_TYPES = ["array", "image", "pdf"] as const
const TOKEN_USAGE_PRICING_FIELDS = [
  "input",
  "output",
  "cachedInput",
  "cacheCreationInput",
  "explicitCachedInput",
  "maxInputTokens",
  "tiers",
] as const
```

Use these constants for validation messages and to avoid duplicated magic strings.

- [ ] **Step 3: Expand provider key allowlists**

Update `PROVIDER_CONFIG_FIELDS` to include:

```ts
"pricingCurrency"
```

Update `PROVIDER_MODEL_CONFIG_FIELDS` to include:

```ts
"extraBody"
"contextCache"
"pricing"
"supportPdf"
"toolContentSupportType"
```

Expected behavior: unsupported provider/provider-model keys still return `400` with a field-specific message.

- [ ] **Step 4: Generalize provider type validation**

Change `applyProviderType()` so it:

1. Parses `providers.<name>.type` as an optional string.
2. Accepts only values where `isSupportedProviderType(parsed.value)` is true.
3. Assigns the parsed supported value to `provider.type`.
4. Returns an error listing supported values from `SUPPORTED_PROVIDER_TYPES` for unsupported values such as `openai`.

Expected accepted values:

```text
anthropic
openai-compatible
openai-responses
```

- [ ] **Step 5: Add provider pricingCurrency parser**

Add `applyProviderPricingCurrency()` and call it from `parseProviderConfig()` after `applyProviderAuthType()` or before `applyProviderModels()`.

Rules:

- Accept optional string.
- Trim whitespace via existing `parseOptionalString()`.
- Empty/null/undefined clears the field.
- Store normalized string as `provider.pricingCurrency`.
- Do not validate ISO currency codes in P0; preserve current backend flexibility.

- [ ] **Step 6: Add provider model boolean parsers**

Add and call helpers:

```ts
applyProviderModelContextCache()
applyProviderModelSupportPdf()
```

Rules:

- Use existing `parseOptionalBoolean()`.
- Accept only booleans for present values.
- Assign `config.contextCache` and `config.supportPdf`.

- [ ] **Step 7: Add toolContentSupportType parser**

Add `applyProviderModelToolContentSupportType()`.

Rules:

- Null/undefined clears the field.
- Value must be an array.
- Every item must be one of `array`, `image`, `pdf`.
- Preserve first-seen order while removing duplicates.
- Assign `config.toolContentSupportType` only when a non-empty normalized array exists.
- Treat an empty normalized array as omitted/cleared; do not persist meaningless empty arrays.
- Reject invalid entries with field-specific messages like `providers.custom.models.foo.toolContentSupportType[0] must be one of: array, image, pdf`.

- [ ] **Step 8: Add extraBody parser**

Add `applyProviderModelExtraBody()`.

Rules:

- Null/undefined clears the field.
- Top-level value must be a plain object.
- Top-level keys must reject `__proto__`, `constructor`, and `prototype`.
- Nested values may be any JSON-like value that can survive config serialization.
- Do not restrict specific `extraBody` keys.
- Assign the object as `config.extraBody`.

- [ ] **Step 9: Add pricing parser**

Add helpers for `TokenUsagePricingConfig` and `TokenUsagePricingTier`:

```ts
parseTokenUsagePricingTier(value, field, allowTiers)
parseTokenUsagePricingConfig(value, field)
applyProviderModelPricing()
```

Rules:

- Null/undefined clears the field.
- Top-level pricing must be a plain object.
- Allowed keys are `input`, `output`, `cachedInput`, `cacheCreationInput`, `explicitCachedInput`, `maxInputTokens`, and `tiers`.
- Numeric price fields must be finite non-negative numbers.
- `maxInputTokens` must be a finite non-negative number; do not require integer unless implementing code reuses an existing integer helper consistently.
- `tiers` must be an array of plain objects.
- Each tier uses the same allowed numeric keys except nested `tiers` is not allowed.
- Do not require tiers to be sorted, exhaustive, or non-overlapping; `resolvePricingTier()` owns runtime selection semantics.
- Reject blocked keys and unknown keys with field-specific messages.

- [ ] **Step 10: Preserve config-layer reasoning behavior**

Do not change:

```ts
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
const REASONING_EFFORTS = new Set<ReasoningEffort>([...])
```

P0 must not add `max` here.

---

## Task 2: Expand Backend Admin Config Tests

**Files:**
- Modify: `tests/admin-config.test.ts`

- [ ] **Step 1: Update provider round-trip happy path**

Extend `POST /api/admin/config updates providers` to include:

```json
{
  "type": "openai-compatible",
  "authType": "oauth2",
  "pricingCurrency": "CNY",
  "models": {
    "kimi-k2.5": {
      "temperature": 1,
      "topP": 0.95,
      "topK": 40,
      "contextCache": true,
      "supportPdf": true,
      "toolContentSupportType": ["array", "image", "pdf"],
      "extraBody": {
        "thinking_budget": 2048,
        "metadata": { "source": "admin-ui" }
      },
      "pricing": {
        "input": 1,
        "output": 2,
        "cachedInput": 0.5,
        "cacheCreationInput": 0.75,
        "explicitCachedInput": 0.25,
        "maxInputTokens": 32000,
        "tiers": [
          {
            "input": 2,
            "output": 4,
            "maxInputTokens": 200000
          }
        ]
      }
    }
  }
}
```

Assert every field round-trips in the response.

- [ ] **Step 2: Add provider type acceptance test**

Add a focused test that posts three providers or three subcases for:

```text
anthropic
openai-compatible
openai-responses
```

Expected: status `200`, response preserves each type.

- [ ] **Step 3: Keep unsupported provider type rejection**

Keep or update `POST /api/admin/config rejects unsupported provider types`.

Expected: `type: "openai"` still returns `400`, and error mentions `providers.custom.type` plus the supported values.

- [ ] **Step 4: Add pricingCurrency tests**

Add tests for:

- `pricingCurrency: " USD "` returns `"USD"`.
- `pricingCurrency: ""` clears/omits the field.
- Non-string `pricingCurrency` returns `400`.

- [ ] **Step 5: Add oauth2 round-trip test**

Add a focused test that posts `authType: "oauth2"` and confirms it round-trips.

Keep invalid `authType: "cookie"` rejection unchanged.

- [ ] **Step 6: Add advanced model field rejection tests**

Add targeted rejection tests:

- `extraBody` is an array -> `400`.
- `extraBody.__proto__` or normalized blocked key -> `400`.
- `contextCache` is a string -> `400`.
- `supportPdf` is a string -> `400`.
- `toolContentSupportType` contains `"audio"` -> `400`.
- `pricing.input` is negative -> `400`.
- `pricing.tiers` is not an array -> `400`.
- `pricing.tiers[0]` is not an object -> `400`.
- `pricing.tiers[0].tiers` is present -> `400`.

- [ ] **Step 7: Add reasoning max protection test**

Add a targeted test proving config-layer `modelReasoningEfforts` still rejects `max` in P0.

Expected: `POST /api/admin/config` with `{ modelReasoningEfforts: { "gpt-5.5": "max" } }` returns `400` and error mentions `modelReasoningEfforts.gpt-5.5`.

---

## Task 3: Expand Admin-UI API Types

**Files:**
- Modify: `admin-ui/src/lib/admin-api.ts`

- [ ] **Step 1: Add provider type union**

Add:

```ts
export type ProviderType = "anthropic" | "openai-compatible" | "openai-responses"
```

Use it for `ProviderConfig.type`.

- [ ] **Step 2: Add provider auth type union**

Add or update:

```ts
export type ProviderAuthType = "authorization" | "oauth2" | "x-api-key"
```

Use it for `ProviderConfig.authType`.

- [ ] **Step 3: Add tool content support union**

Add:

```ts
export type ToolContentSupportType = "array" | "image" | "pdf"
```

- [ ] **Step 4: Add pricing types**

Add Admin-UI wire-compatible pricing types matching backend config:

```ts
export type TokenUsagePricingTier = {
  cachedInput?: number
  cacheCreationInput?: number
  explicitCachedInput?: number
  input?: number
  maxInputTokens?: number
  output?: number
}

export type TokenUsagePricingConfig = TokenUsagePricingTier & {
  tiers?: Array<TokenUsagePricingTier>
}
```

- [ ] **Step 5: Expand ProviderModelConfig and ProviderConfig**

Update:

```ts
export type ProviderModelConfig = {
  temperature?: number
  topP?: number
  topK?: number
  extraBody?: Record<string, unknown>
  contextCache?: boolean
  pricing?: TokenUsagePricingConfig
  supportPdf?: boolean
  toolContentSupportType?: Array<ToolContentSupportType>
}

export type ProviderConfig = {
  type?: ProviderType
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  authType?: ProviderAuthType
  pricingCurrency?: string
  adjustInputTokens?: boolean
  models?: Record<string, ProviderModelConfig>
}
```

Do not change `ReasoningEffort` to include `max`.

---

## Task 4: Preserve Provider Fields in Settings State

**Files:**
- Modify: `admin-ui/src/pages/settings-page.tsx`

- [ ] **Step 1: Import new Admin-UI types**

Import `ProviderAuthType`, `ProviderType`, `TokenUsagePricingConfig`, and `ToolContentSupportType` from `@/lib/admin-api` once they exist.

Remove local derivation if it becomes redundant:

```ts
type ProviderAuthType = NonNullable<ProviderConfig["authType"]>
```

- [ ] **Step 2: Add UI constants**

Add constants near `REASONING_EFFORTS`:

```ts
const PROVIDER_TYPES: Array<ProviderType> = [
  "anthropic",
  "openai-compatible",
  "openai-responses",
]

const PROVIDER_AUTH_TYPES: Array<ProviderAuthType> = [
  "x-api-key",
  "authorization",
  "oauth2",
]

const TOOL_CONTENT_SUPPORT_TYPES: Array<ToolContentSupportType> = [
  "array",
  "image",
  "pdf",
]
```

Do not add `max` to `REASONING_EFFORTS`.

- [ ] **Step 3: Extend ProviderModelItem and ProviderItem**

Add raw string/editor fields:

```ts
type ProviderModelItem = {
  id: string
  model: string
  temperature: string
  topP: string
  topK: string
  contextCache: boolean
  supportPdf: boolean
  toolContentSupportType: Array<ToolContentSupportType>
  pricingJson: string
  extraBodyJson: string
}

type ProviderItem = {
  id: string
  name: string
  type: ProviderType
  enabled: boolean
  baseUrl: string
  apiKey: string
  authType: ProviderAuthType
  pricingCurrency: string
  adjustInputTokens: boolean
  models: Array<ProviderModelItem>
}
```

- [ ] **Step 4: Preserve fields in providerItemsFromRecord()**

Update `providerItemsFromRecord()` so each provider item preserves:

- `type`, defaulting to `anthropic` only when undefined.
- `pricingCurrency`, defaulting to `""`.
- model `contextCache`, defaulting to `false`.
- model `supportPdf`, defaulting to `false`.
- model `toolContentSupportType`, defaulting to `[]`.
- model `pricingJson`, using `JSON.stringify(config.pricing ?? {}, null, 2)`.
- model `extraBodyJson`, using `JSON.stringify(config.extraBody ?? {}, null, 2)`.

- [ ] **Step 5: Update meaningful-content detection**

Update `providerHasMeaningfulContent()` to treat these as meaningful:

- `item.type !== "anthropic"`
- `item.pricingCurrency.trim()`
- model `contextCache`
- model `supportPdf`
- non-empty `toolContentSupportType`
- non-empty/non-`{}` `pricingJson`
- non-empty/non-`{}` `extraBodyJson`

- [ ] **Step 6: Add JSON parse helpers**

Add helper functions:

```ts
parseOptionalPlainObjectJson(value, field)
parseOptionalPricingJson(value, field)
```

Rules:

- Empty string and `{}` both mean omitted field.
- Invalid JSON returns a field-specific form issue.
- `extraBodyJson` must parse to a plain object.
- `pricingJson` must parse to a plain object and follow the same lightweight schema as backend.
- Keep UI validation aligned with Admin API but do not duplicate unrelated backend parser complexity.

- [ ] **Step 7: Expand parseSingleModelItem()**

Update `parseSingleModelItem()` so model rows can create a config from any supported advanced field, not just numeric overrides.

Rules:

- A blank model id with any advanced field set returns the existing “model id is required when setting overrides” style error.
- `contextCache` and `supportPdf` write booleans only when true.
- `toolContentSupportType` writes only non-empty arrays.
- `pricingJson` writes parsed `pricing` when non-empty.
- `extraBodyJson` writes parsed `extraBody` when non-empty.
- `Object.keys(config).length === 0` still omits empty model rows.

- [ ] **Step 8: Expand providerRecordFromItems()**

Update the provider object assembly to include:

```ts
pricingCurrency: pricingCurrency || undefined
```

Use `item.type` as a `ProviderType`; do not let arbitrary strings through form mode.

- [ ] **Step 9: Update onAddProvider() and onAddModel() defaults**

Provider defaults:

```ts
type: "anthropic"
authType: "x-api-key"
pricingCurrency: ""
```

Model defaults:

```ts
contextCache: false
supportPdf: false
toolContentSupportType: []
pricingJson: ""
extraBodyJson: ""
```

---

## Task 5: Add Settings Form Controls

**Files:**
- Modify: `admin-ui/src/pages/settings-page.tsx`
- Modify: `admin-ui/src/locales/en-US.json`
- Modify: `admin-ui/src/locales/zh-CN.json`

- [ ] **Step 1: Add provider type selector**

In the provider card rendering around the existing name/enabled/baseUrl/apiKey/authType fields, add a `Select` for `item.type`.

Options:

```text
anthropic
openai-compatible
openai-responses
```

Use localized labels but keep the stored values exact.

- [ ] **Step 2: Add oauth2 authType option and warning**

Add `oauth2` as an auth type option.

Add helper/warning copy near the auth type field:

- English: `OAuth2 is mainly for built-in or special providers such as Codex. For regular custom providers, prefer x-api-key or Authorization unless the backend integration explicitly supports OAuth2.`
- Chinese: `OAuth2 主要用于 Codex 等内置或特殊 provider。普通自定义 provider 建议优先使用 x-api-key 或 Authorization，除非对应后端集成明确支持 OAuth2。`

- [ ] **Step 3: Add pricingCurrency input**

Add an input under provider-level fields.

Expected placeholder examples:

```text
USD
CNY
```

Do not enforce ISO validation in UI P0.

- [ ] **Step 4: Add provider model advanced controls**

For each provider model row, keep existing `model`, `temperature`, `topP`, `topK` controls and add an advanced section. It can be inline under the row or a simple bordered block; do not introduce a new accordion dependency.

Controls:

- `contextCache` switch.
- `supportPdf` switch.
- `toolContentSupportType` multi-select or simple checkbox group for `array`, `image`, `pdf`.
- `pricingJson` textarea.
- `extraBodyJson` textarea.

- [ ] **Step 5: Surface parser errors in existing provider issue area**

Reuse `providersIssue` / `InlineAlert` instead of adding separate local error systems.

Expected: invalid `pricingJson` or `extraBodyJson` blocks save via existing “issue disables clean config update” path.

- [ ] **Step 6: Update locale keys**

Add/update keys under `settingsPage.advanced` for:

- provider type label and option labels.
- pricing currency label/placeholder.
- oauth2 option and hint.
- model advanced section title.
- context cache label/hint.
- support PDF label/hint.
- tool content support label/options.
- pricing JSON label/placeholder/hint.
- extra body JSON label/placeholder/hint.

Remove or replace any `providersDescription` copy that says provider support is currently `anthropic` only.

---

## Task 6: Add Admin-UI Round-Trip Tests or Type-Safe Coverage

**Files:**
- Prefer adding tests under `admin-ui/tests/` if the existing Admin-UI test setup supports it.
- If no Admin-UI test runner is configured, keep frontend coverage through exported helper tests only if a local test harness already exists; otherwise document the gap and rely on `admin-ui` typecheck/build for P0.
- Modify candidate: `admin-ui/src/pages/settings-page.tsx` only if helper exports are already used by tests or can be exported without leaking UI internals too broadly.

- [ ] **Step 1: Check existing Admin-UI test setup during implementation**

Before adding frontend tests, inspect:

```text
admin-ui/package.json
admin-ui/tests/**
admin-ui/src/**/*.test.ts
admin-ui/src/**/*.test.tsx
```

If there is no configured test command and no existing test pattern, do not introduce a new test framework in P0.

- [ ] **Step 2: Add helper-level tests if feasible**

If feasible, cover:

- `providerItemsFromRecord()` preserves `type`, `authType`, `pricingCurrency`, and all provider model advanced fields.
- `providerRecordFromItems()` reconstructs the same fields.
- Invalid `extraBodyJson` returns a provider issue.
- Invalid `pricingJson` returns a provider issue.
- `REASONING_EFFORTS` still does not contain `max`.

- [ ] **Step 3: Otherwise use build/typecheck as frontend gate**

If no frontend test harness exists, record this in the final implementation summary and run:

```bash
bun run build:admin
```

This is acceptable for P0 only because backend parser tests cover the contract, and Admin-UI typecheck/build covers the typed client and JSX wiring.

---

## Task 7: Verify P0 End-to-End

**Files:**
- Verify modified backend/Admin-UI files only.

- [ ] **Step 1: Run targeted backend tests**

```bash
bun test tests/admin-config.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run root typecheck**

```bash
bun run typecheck
```

Expected: pass.

- [ ] **Step 3: Run Admin-UI typecheck and build**

```bash
bun run typecheck:admin
bun run build:admin
```

Expected: both pass.

- [ ] **Step 4: Run broader safety tests if time allows**

Recommended after P0 changes because config/provider behavior is central:

```bash
bun test tests/admin-config.test.ts tests/provider-openai-compatible.test.ts tests/provider-model-alias.test.ts
```

Expected: pass.

- [ ] **Step 5: Check formatting and conflict markers**

```bash
git diff --check
git diff --name-only --diff-filter=U
rg -n -e '^<{7} ' -e '^={7}$' -e '^>{7} ' src admin-ui tests docs
```

Expected: no output from `git diff --check`, no unresolved files from `git diff --name-only --diff-filter=U`, and conflict marker search returns no real conflict markers.

---

## Acceptance Criteria

P0 is complete only when all of these are true:

- Admin API accepts and round-trips provider `type` values `anthropic`, `openai-compatible`, and `openai-responses`.
- Admin API accepts and round-trips provider `authType: "oauth2"`.
- Admin API accepts and round-trips provider `pricingCurrency`.
- Admin API accepts and round-trips provider model `extraBody`, `contextCache`, `pricing`, `supportPdf`, and `toolContentSupportType`.
- Admin API rejects invalid provider type, invalid auth type, invalid advanced field shapes, invalid pricing, invalid tool content support values, and blocked keys.
- Admin-UI API types mirror backend provider config fields.
- Admin-UI Settings form mode preserves all P0 provider fields.
- Admin-UI Settings JSON mode still preserves all P0 provider fields because `AdminConfig` types include them.
- Admin-UI locale copy no longer says providers are `anthropic` only.
- Config-layer `modelReasoningEfforts` still does not include `max`.
- `bun test tests/admin-config.test.ts`, `bun run typecheck`, `bun run typecheck:admin`, and `bun run build:admin` pass.

---

## Non-Goals

- No Token Usage page or `/token-usage` API client in P0 implementation, despite the broader design mentioning it.
- No quick provider templates in Admin-UI.
- No `/v1/models` aggregated preview.
- No pricing synchronization from remote provider metadata.
- No visual redesign of Settings beyond minimal fields needed for safe editing.
- No change to Copilot multi-account selection, account affinity, quota refresh, or token refresh logic.

---

## Implementation Notes

- Keep backend validation small and explicit; do not introduce a generic schema library for this single parser.
- Keep the Settings page implementation pragmatic. The file is already large, so avoid broad refactors unrelated to P0.
- JSON textareas are acceptable for `pricing` and `extraBody`; this follows KISS/YAGNI and avoids building a complex tier editor prematurely.
- Use descriptive helper names and keep validation messages field-specific so tests can assert useful errors.
- If an implementation step discovers that `TokenUsagePricingConfig` accepts a value not listed here, update the plan before coding further rather than silently expanding scope.

## Execution Boundary

This plan intentionally does not include `git commit`, `git push`, branch creation, release packaging, Electron UI changes, or production deployment. Those require separate explicit user instruction.
