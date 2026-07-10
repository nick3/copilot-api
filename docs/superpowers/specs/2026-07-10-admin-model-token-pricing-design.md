# Admin Model Token Pricing Design

Date: 2026-07-10
Status: Approved

## Problem

The Admin-UI Models table receives model metadata through
`GET /api/admin/models/details`. GitHub Copilot's upstream `/models` response
contains token pricing in a tiered structure:

```json
{
  "batch_size": 1000000,
  "default": {
    "cache_price": 50,
    "cache_write_price": 625,
    "context_max": 200000,
    "input_price": 500,
    "output_price": 2500
  },
  "long_context": {
    "cache_price": 100,
    "context_max": 936000,
    "input_price": 1000,
    "output_price": 4500
  }
}
```

The current backend and frontend types expect the price fields directly under
`token_prices`. The Admin API therefore removes the tier contents and returns
only `batch_size`; the UI enters its token-price branch but renders em dashes.
The UI also divides prices by `1_000_000_000`, even though tiered prices are
already AI Credits per `batch_size` tokens.

## Chosen Approach

Preserve the upstream tiered contract end to end and normalize only for
presentation. This keeps `default` and `long_context` distinct, retains
`context_max` and `cache_write_price`, and avoids inventing a lossy flattened
Admin API contract.

Two alternatives were rejected:

1. Flatten `default` into the old fields. This would silently discard the
   higher price used by models whose long-context tier differs.
2. Pass arbitrary billing JSON through without parsing. This would expose
   malformed or unexpected fields and make the UI depend directly on an
   unvalidated upstream payload.

## Data Contract

Both backend and Admin-UI model types will represent:

```ts
type ModelTokenPriceTier = {
  cache_price?: number
  cache_write_price?: number
  context_max?: number
  input_price?: number
  output_price?: number
}

type ModelTokenPrices = ModelTokenPriceTier & {
  batch_size?: number
  default?: ModelTokenPriceTier
  long_context?: ModelTokenPriceTier
}
```

The direct tier fields remain optional for compatibility with the legacy flat
payload. The Admin API parser accepts only finite numeric values and preserves
the two known tiers.

Shared billing detection considers a price object populated when any supported
price field is finite in the direct, default, or long-context tier. A
`batch_size` by itself is not sufficient to mark a model token-priced.

## Price Normalization

Tiered prices are AI Credits per `batch_size` tokens. They are normalized to
the table's per-million unit with:

```ts
price * 1_000_000 / batch_size
```

With the normal `batch_size` of 1,000,000, the displayed price is the upstream
value unchanged. A zero price remains zero even when `batch_size` is zero.
Positive prices with an invalid or zero batch size are treated as unavailable.

Legacy flat prices retain their historical nano-AI-Credits conversion before
batch normalization:

```ts
(price / 1_000_000_000) * 1_000_000 / batch_size
```

If a legacy payload omits `batch_size`, it is assumed to already describe a
one-million-token batch, matching the previous Admin-UI behavior.

## Admin-UI Presentation

The billing cell continues to show input, cached input, and output AI Credits.
The default tier is displayed first. A long-context tier is displayed with its
threshold when its normalized prices differ from the default tier. Identical
tiers are collapsed to avoid duplicate rows.

`cache_write_price` is preserved in the data contract but is not added to the
table in this change because the requested UI surface contains the existing
three price categories.

If no token price tier is available, the existing legacy request multiplier
fallback remains unchanged.

## Validation and Error Handling

- Ignore non-numeric and non-finite price or context fields.
- Do not infer token billing from `batch_size` alone.
- Preserve valid zero prices.
- Preserve legacy flat payload support.
- Do not let malformed pricing prevent the rest of a model row from rendering.

## Tests

- Backend Admin API integration test with a complete tiered Copilot model.
- Shared billing tests for tiered, legacy flat, empty, and zero prices.
- Admin-UI normalization tests for tiered values, legacy nanos, batch scaling,
  zero prices, identical tiers, and long-context thresholds.
- Billing-cell static render tests that assert real numbers replace em dashes.
- Existing Admin API, Admin-UI, typecheck, lint, build, and full Bun tests.
