# Admin Model Token Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve GitHub Copilot's tiered model token prices and display correct AI Credits per million tokens in Admin-UI.

**Architecture:** Model the upstream `default` and `long_context` tiers explicitly, validate them at the Admin API boundary, and centralize UI price normalization in `admin-ui/src/lib/model-billing.ts`. The Models page renders normalized tiers while retaining the existing multiplier fallback and legacy flat-price compatibility.

**Tech Stack:** Bun, strict TypeScript, Hono, React 19, react-i18next, Bun test runner.

## Global Constraints

- Do not add dependencies.
- Preserve `default`, `long_context`, `context_max`, and `cache_write_price`.
- Display input, cached input, and output prices; do not add a cache-write row.
- Preserve legacy flat nano-AI-Credits payload behavior.
- Ignore malformed or non-finite price values.
- Do not modify unrelated model aggregation behavior.
- Changed code must reach at least 85% unit-test coverage.
- Do not create commits; the user requested implementation in the shared workspace, not repository history changes.

---

### Task 1: Backend tiered pricing contract

**Files:**
- Modify: `tests/admin-models-details.test.ts`
- Modify: `tests/accounts-manager-reservation.test.ts`
- Modify: `src/services/copilot/get-models.ts`
- Modify: `src/lib/model-billing.ts`
- Modify: `src/routes/admin-api/route.ts`

**Interfaces:**
- Produces: exported `ModelTokenPriceTier` and `ModelTokenPrices` wire types.
- Produces: `hasTokenPrices()` support for direct, default, and long-context tiers.
- Produces: `/api/admin/models/details` response preserving validated pricing tiers.

- [x] **Step 1: Replace the Admin details test fixture with a real tiered price object**

```ts
token_prices: {
  batch_size: 1_000_000,
  default: {
    cache_price: 50,
    cache_write_price: 625,
    context_max: 200_000,
    input_price: 500,
    output_price: 2500,
  },
  long_context: {
    cache_price: 100,
    context_max: 936_000,
    input_price: 1000,
    output_price: 4500,
  },
}
```

- [x] **Step 2: Add an account integration assertion for tiered token-price detection**

```ts
expect(statuses[0].tokenBasedBilling).toBe(true)
```

- [x] **Step 3: Run the backend tests and verify RED**

Run: `bun test tests/admin-models-details.test.ts tests/accounts-manager-reservation.test.ts`

Expected: the Admin response omits `default` and `long_context`, and the account runtime reports tiered prices as non-billable.

- [x] **Step 4: Add the tiered model types and update shared detection**

```ts
export interface ModelTokenPriceTier {
  cache_price?: number
  cache_write_price?: number
  context_max?: number
  input_price?: number
  output_price?: number
}

export interface ModelTokenPrices extends ModelTokenPriceTier {
  batch_size?: number
  default?: ModelTokenPriceTier
  long_context?: ModelTokenPriceTier
}
```

`hasTokenPrices()` must inspect all three possible tier locations and all four
price fields, including valid zero values.

- [x] **Step 5: Parse and preserve known tiers in the Admin API**

Add `parseTokenPriceTier()` for finite numeric fields. Update
`parseTokenPrices()` to preserve direct legacy fields, `batch_size`, `default`,
and `long_context`. Set `token_based` only when `hasTokenPrices()` is true.

- [x] **Step 6: Run the backend tests and verify GREEN**

Run: `bun test tests/admin-models-details.test.ts tests/accounts-manager-reservation.test.ts`

Expected: all tests pass and the tiered values survive the real Admin route.

---

### Task 2: Admin-UI price normalization

**Files:**
- Modify: `admin-ui/tests/admin-ui-subagent-request.test.ts`
- Create: `admin-ui/tests/model-billing.test.ts`
- Modify: `admin-ui/src/lib/admin-api.ts`
- Modify: `admin-ui/src/lib/model-billing.ts`

**Interfaces:**
- Produces: `AdminModelTokenPriceTier` and expanded `AdminModelTokenPrices`.
- Produces: `hasAdminModelTokenPrices()`.
- Produces: `getModelAiCreditsPriceTiers()` returning normalized display tiers.

- [x] **Step 1: Add nested price normalization and billing-detection tests**

```ts
expect(getModelAiCreditsPriceTiers({
  batch_size: 1_000_000,
  default: { input_price: 500, cache_price: 50, output_price: 2500 },
})).toEqual([{
  key: "default",
  input: 500,
  cache: 50,
  output: 2500,
  contextMax: undefined,
}])
```

Also cover long-context prices, legacy flat nanos, non-million batch sizes,
zero prices, and identical-tier collapsing.

- [x] **Step 2: Run the Admin-UI utility tests and verify RED**

Run: `bun test admin-ui/tests/model-billing.test.ts admin-ui/tests/admin-ui-subagent-request.test.ts`

Expected: the new helper is missing and nested prices do not infer token billing.

- [x] **Step 3: Expand Admin-UI types and implement pure normalization helpers**

For tiered values use `price * 1_000_000 / batch_size`. For direct legacy
values first divide by `1_000_000_000`. Preserve valid zero values and return
`undefined` for a positive value with an invalid zero batch.

- [x] **Step 4: Use shared detection in Admin model normalization**

```ts
tokenBasedBilling:
  billing.tokenBasedBilling
  ?? billing.token_based
  ?? (hasAdminModelTokenPrices(billing.token_prices) ? true : undefined)
```

- [x] **Step 5: Run the Admin-UI utility tests and verify GREEN**

Run: `bun test admin-ui/tests/model-billing.test.ts admin-ui/tests/admin-ui-subagent-request.test.ts`

Expected: all normalization and compatibility tests pass.

---

### Task 3: Billing cell rendering

**Files:**
- Modify: `admin-ui/tests/models-page.test.tsx`
- Modify: `admin-ui/src/pages/models-page.tsx`
- Modify: `admin-ui/src/locales/en-US.json`
- Modify: `admin-ui/src/locales/zh-CN.json`

**Interfaces:**
- Consumes: `getModelAiCreditsPriceTiers()` from Task 2.
- Produces: an exported `ModelBillingCell` component used by `ModelsPage`.

- [x] **Step 1: Add static render tests for default and long-context pricing**

Wrap `ModelBillingCell` in `TooltipProvider`. Assert that a Claude-style tier
renders `500`, `50`, and `2,500` without an em dash, and that a Gemini-style
long-context tier renders both default and higher long-context values with its
200K threshold.

- [x] **Step 2: Run the models page test and verify RED**

Run: `bun test admin-ui/tests/models-page.test.tsx`

Expected: current `BillingCell` is not exported and renders only flat prices.

- [x] **Step 3: Replace page-local scaling with normalized tier rendering**

Rename and export `ModelBillingCell`, use `getModelAiCreditsPriceTiers()`, and
render tier labels when more than one tier remains after collapsing or when
the only available tier is the long-context tier.

- [x] **Step 4: Add localized tier labels**

```json
"defaultTier": "Default",
"longContextTier": "Long context > {{tokenCount}} tokens"
```

Add equivalent Chinese copy.

- [x] **Step 5: Run the models page test and verify GREEN**

Run: `bun test admin-ui/tests/models-page.test.tsx`

Expected: all billing values and tier labels render correctly.

---

### Task 4: Verification

**Files:**
- Verify all modified source, test, locale, spec, and plan files.

- [x] **Step 1: Run focused tests**

```bash
bun test tests/admin-models-details.test.ts tests/accounts-manager-reservation.test.ts
bun test admin-ui/tests/model-billing.test.ts admin-ui/tests/admin-ui-subagent-request.test.ts admin-ui/tests/models-page.test.tsx
```

- [x] **Step 2: Run project checks**

```bash
bun run typecheck
bun run typecheck:admin
bun run lint:all
bun run lint:admin
bun run build:admin
bun test
```

- [x] **Step 3: Measure changed-code coverage**

Run targeted Bun tests with `--coverage` and confirm each changed executable
module reaches at least 85% line coverage, adding focused tests where needed.

- [x] **Step 4: Inspect the final diff**

```bash
git diff --check
git status --short
git diff -- src admin-ui tests docs/superpowers
```

Confirm there are no debug artifacts, unrelated model aggregation changes,
credentials, generated secrets, or accidental formatting churn.
