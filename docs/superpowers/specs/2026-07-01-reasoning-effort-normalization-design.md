# Reasoning Effort Normalization Design

> Status: DRAFT, awaiting user review
> Date: 2026-07-01

## Problem

GitHub Copilot now exposes multiple mainstream model families, including GPT, Claude, and Gemini. Their supported reasoning effort values differ by model and must be discovered from Copilot's upstream `/models` response.

The project already fetches and caches upstream model metadata at startup and during periodic model refreshes. Each model can expose `capabilities.supports.reasoning_effort`, an array of supported effort values.

Today reasoning effort behavior is inconsistent:

- Admin UI shows a fixed global effort list instead of model-specific supported values.
- `modelReasoningEfforts` validation accepts a fixed global set but does not know which model supports which values.
- `/v1/messages -> /responses` always writes the configured model effort and can override an explicit downstream effort.
- `/v1/chat/completions` only injects a configured default for the `gpt-5-mini` family.
- `/v1/responses` preserves explicit `reasoning.effort` but does not inject a configured default when omitted.

This makes the configured default behave differently depending on route selection and makes user-supplied values unreliable when request and upstream APIs differ.

## Goal

Make reasoning effort handling predictable across Copilot routes:

1. Use upstream model metadata as the source of truth for supported reasoning effort values.
2. Let Admin UI show model-specific effort choices, including alias models.
3. Treat configured model effort as a user intent default, not as an unconditional override.
4. Preserve explicit downstream effort when present.
5. When an explicit or configured effort is unsupported by the target upstream model, normalize it to the nearest supported value.
6. Avoid sending reasoning effort fields to upstream models that do not advertise support.

## Non-Goals

- Do not introduce provider-specific reasoning effort support for external providers in this change.
- Do not add new cross-endpoint routing behavior such as `/v1/chat/completions -> /responses` unless a separate routing design asks for it.
- Do not infer model support from family names when cached `/models` metadata is unavailable.

## Existing Model Metadata

`src/services/copilot/get-models.ts` already defines `ModelCapabilities.supports.reasoning_effort?: Array<string>`.

`accountsManager.getFirstAccountModels()` already provides the cached Copilot model response used by Admin API and routing code. The reasoning effort design should reuse this cache rather than fetching `/models` on demand from Admin UI or individual request handlers.

Alias models should not define independent capabilities. Their supported effort options come from the resolved target model.

## Canonical Effort Order

Define one ordered effort scale:

```text
none < minimal < low < medium < high < xhigh < max
```

The config and downstream request may express any value in this scale, including `max`.

The upstream model may support a subset. For example:

```text
["low", "medium", "high", "xhigh"]
```

## Normalization Rule

Reasoning effort processing has two phases:

1. Determine the requested intent effort.
2. Normalize that intent to the final upstream model support list.

Intent selection:

```text
explicit downstream effort
  ?? configured default for requested model / alias fallback
  ?? no effort
```

Normalization:

1. If there is no intent effort, do not send effort.
2. If the target model has no non-empty `reasoning_effort` support list, do not send effort.
3. If the target model supports the intent effort, send it unchanged.
4. Otherwise send the closest supported effort by canonical scale distance.
5. If two supported values are equally close, choose the lower effort.

Examples:

| Intent | Target support | Upstream effort |
|---|---|---|
| `max` | `low, medium, high, xhigh` | `xhigh` |
| `minimal` | `low, medium, high` | `low` |
| `xhigh` | `low, medium, high` | `high` |
| `medium` | `low, high` | `low` |
| `high` | empty / missing | omitted |

## API Field Mapping

Each API has a different effort field:

| API shape | Field |
|---|---|
| Messages API | `output_config.effort` |
| Responses API | `reasoning.effort` |
| Chat Completions API | `reasoning_effort` |

The same intent and normalization rule applies to direct and translated flows. The only difference is where the normalized effort is written.

## Runtime Flow

After route handling determines the final upstream model and endpoint, call a shared reasoning effort helper with:

- client/request model id
- final upstream model
- explicit downstream effort, if any
- configured `modelReasoningEfforts`
- model aliases

The helper returns either a normalized effort or `undefined`.

The route or translator writes the result into the target upstream payload:

- `/v1/messages -> /v1/messages`: write `output_config.effort`.
- `/v1/messages -> /responses`: write `reasoning.effort`.
- `/v1/messages -> /chat/completions`: write `reasoning_effort`.
- `/v1/responses -> /responses`: write `reasoning.effort`.
- `/v1/chat/completions -> /chat/completions`: write `reasoning_effort`.

If the helper returns `undefined`, remove or omit the target effort field so the upstream request does not carry unsupported effort data.

## Direct vs Translated Requests

Direct API flows mean the downstream API shape and upstream API shape match. Explicit downstream effort should be preserved semantically, then normalized only if the final upstream model does not support that exact value.

Translated API flows mean the downstream API shape and upstream API shape differ. The downstream effort should first be extracted as intent, then normalized against the final upstream model, then written in the target API field format.

This keeps direct and translated behavior aligned while still adapting field names.

## Config Semantics

`modelReasoningEfforts` expresses default user intent per model. It is not a guarantee that the exact configured value will be sent upstream.

Rules:

- Values must be in the canonical global set, including `max`.
- Config may contain aliases or target model ids.
- Existing alias fallback behavior should continue to work.
- Config save should not reject a value merely because the current target model does not support it. Runtime normalization adapts it.
- If a model mapping rewrites the request to another model, the default intent should be resolved from the client/request model, while support should be resolved from the final upstream model.

## Admin API

Extend `/api/admin/models/details` so each item exposes:

```ts
capabilities: {
  supports: {
    reasoning_effort?: string[]
    // existing support flags...
  }
}
aliases: string[]
```

The response should include the raw target model support list. Alias-to-target relationships are already available through `aliases`.

The existing `/api/admin/models` string-list endpoint can remain for simple model selectors, but the Settings page reasoning editor should load model details when it needs model-specific effort options.

## Admin UI

The Settings page reasoning editor should use model details to render effort options:

1. Selecting a concrete model shows that model's `reasoning_effort` values.
2. Selecting an alias shows the alias as the configured model key but uses the alias target model's support list.
3. If no support list exists, disable the effort select and show that the model does not support reasoning effort.
4. JSON mode remains available and accepts all canonical values.
5. Existing values not currently supported by a selected model should not be silently dropped. The UI can show the configured value with an indication that runtime will normalize it.

Form mode should prefer supported values because it represents practical choices. JSON mode remains the escape hatch for intent values like `max`.

## Implementation Boundaries

Add a shared module such as `src/lib/reasoning-effort.ts` for:

- canonical effort types and order
- effort parsing
- nearest supported effort normalization
- helper for extracting model support from a `Model`

Route and translation code should call this module rather than embedding endpoint-specific effort logic.

The `gpt-5-mini`-only default injection in `createChatCompletions()` should be removed or made redundant once route-level normalization covers all supported models. Service clients should primarily send already-prepared payloads.

## Edge Cases

- Unknown effort values from requests are ignored unless they are added to the canonical scale.
- Unknown effort values from upstream `reasoning_effort` metadata are ignored for nearest-value calculations.
- If all upstream support values are unknown after filtering, omit effort.
- If explicit downstream effort is `null`, treat it as omitted and use config default.
- If config default is present but the target model lacks support metadata, omit effort.
- If request model is an alias, configured defaults may be found on either alias or target through existing fallback behavior; support comes from the final selected target model.

## Test Plan

Unit tests:

- Normalize `max -> xhigh` when support stops at `xhigh`.
- Normalize `minimal -> low` when support starts at `low`.
- Normalize `xhigh -> high` when support stops at `high`.
- Pick lower effort on ties, such as `medium` with support `low, high`.
- Return `undefined` when support is missing or empty.
- Ignore unknown metadata values safely.

Route/translation tests:

- `/v1/messages -> /responses` preserves explicit downstream effort as intent and no longer lets config override it.
- `/v1/messages -> /messages` injects config default when omitted and normalizes explicit values by support.
- `/v1/messages -> /chat/completions` writes normalized `reasoning_effort`.
- `/v1/responses -> /responses` injects config default when omitted and normalizes explicit `reasoning.effort`.
- `/v1/chat/completions -> /chat/completions` applies default injection consistently for all models with support, not only `gpt-5-mini`.

Admin tests:

- `/api/admin/models/details` includes `reasoning_effort`.
- Settings page effort options change by selected model.
- Alias model options inherit the target model's support list.
- JSON mode accepts `max`.
- Existing unsupported configured values are preserved in draft state.

## Open Questions

No open business questions remain from the initial design discussion. The implementation plan should decide exact helper function signatures and the smallest set of handler/translator call sites to update.
