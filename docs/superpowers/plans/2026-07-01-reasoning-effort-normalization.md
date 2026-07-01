# Reasoning Effort Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize reasoning effort defaults and explicit request values against each final Copilot upstream model's advertised support list.

**Architecture:** Add one shared reasoning-effort helper module, then route all Chat Completions, Responses, and Messages request preparation through it after the final upstream model is selected. Extend Admin API and Admin UI so model-specific reasoning effort support from cached `/models` metadata is visible and usable in settings.

**Tech Stack:** Bun test runner, TypeScript, Hono route handlers, React Admin UI with existing shadcn-style controls.

---

## File Structure

- Create `src/lib/reasoning-effort.ts`: owns canonical effort order, parsing, support filtering, nearest-value normalization, and request default resolution.
- Create `tests/reasoning-effort.test.ts`: focused unit coverage for helper semantics.
- Modify `src/lib/config.ts`: allow `max` in `modelReasoningEfforts`.
- Modify `src/routes/admin-api/route.ts`: allow `max` in config validation and expose `capabilities.supports.reasoning_effort` from model details.
- Modify `admin-ui/src/lib/admin-api.ts`: update wire/UI types for `max` and model detail support arrays.
- Modify `admin-ui/src/pages/settings-page.tsx`: load model details, derive reasoning support for aliases, and render model-specific effort options.
- Modify `admin-ui/tests/settings-page.test.tsx`: cover model-specific and alias reasoning effort rendering plus JSON `max`.
- Modify `tests/admin-config.test.ts`: accept `max` in config save.
- Modify `tests/admin-models-details.test.ts`: assert model detail support metadata includes `reasoning_effort`.
- Modify `src/services/copilot/create-chat-completions.ts`: remove service-layer `gpt-5-mini` default injection once route-level normalization exists.
- Modify `src/services/copilot/create-responses.ts`: include `max` in the `Reasoning.effort` type.
- Modify `src/routes/chat-completions/handler.ts`: normalize `reasoning_effort` after account/model selection.
- Modify `src/routes/responses/handler.ts`: normalize `reasoning.effort` after account/model selection.
- Modify `src/routes/messages/preprocess.ts`: use the shared helper for native Messages API payload preparation.
- Modify `src/routes/messages/non-stream-translation.ts`: keep downstream effort extraction, with final normalization happening after selection.
- Modify `src/routes/messages/responses-translation.ts`: accept normalized effort from the handler instead of reading config directly.
- Modify `src/routes/messages/handler.ts`: pass normalized effort into Messages, Responses, and Chat Completions upstream paths.
- Modify `tests/chat-completions-handler.test.ts`, `tests/responses-handler.test.ts`, and `tests/messages-handler.test.ts`: verify route behavior.
- Modify `tests/create-chat-completions.test.ts`: remove or update tests that assert the old `gpt-5-mini` service special case.

---

### Task 1: Shared Reasoning Effort Helper

**Files:**
- Create: `src/lib/reasoning-effort.ts`
- Create: `tests/reasoning-effort.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/reasoning-effort.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  getReasoningEffortSupport,
  normalizeReasoningEffortForSupport,
  parseReasoningEffort,
  resolveReasoningEffortForTarget,
} from "~/lib/reasoning-effort"

const buildModel = (
  reasoningEffort?: Array<string>,
): Pick<Model, "capabilities"> => ({
  capabilities: {
    family: "test",
    limits: {},
    object: "capabilities",
    supports: {
      reasoning_effort: reasoningEffort,
    },
    tokenizer: "test",
    type: "chat",
  },
})

describe("reasoning effort normalization", () => {
  test("parses only canonical effort values", () => {
    expect(parseReasoningEffort("none")).toBe("none")
    expect(parseReasoningEffort("minimal")).toBe("minimal")
    expect(parseReasoningEffort("low")).toBe("low")
    expect(parseReasoningEffort("medium")).toBe("medium")
    expect(parseReasoningEffort("high")).toBe("high")
    expect(parseReasoningEffort("xhigh")).toBe("xhigh")
    expect(parseReasoningEffort("max")).toBe("max")
    expect(parseReasoningEffort("ultra")).toBeUndefined()
    expect(parseReasoningEffort(null)).toBeUndefined()
  })

  test("normalizes to the closest supported lower value on ties", () => {
    expect(
      normalizeReasoningEffortForSupport("max", [
        "low",
        "medium",
        "high",
        "xhigh",
      ]),
    ).toBe("xhigh")
    expect(
      normalizeReasoningEffortForSupport("minimal", [
        "low",
        "medium",
        "high",
      ]),
    ).toBe("low")
    expect(
      normalizeReasoningEffortForSupport("xhigh", [
        "low",
        "medium",
        "high",
      ]),
    ).toBe("high")
    expect(normalizeReasoningEffortForSupport("medium", ["low", "high"])).toBe(
      "low",
    )
  })

  test("omits effort when support is missing, empty, or unknown", () => {
    expect(normalizeReasoningEffortForSupport("high", undefined)).toBeUndefined()
    expect(normalizeReasoningEffortForSupport("high", [])).toBeUndefined()
    expect(
      normalizeReasoningEffortForSupport("high", ["turbo", "ultra"]),
    ).toBeUndefined()
  })

  test("extracts sorted unique canonical support from model metadata", () => {
    expect(
      getReasoningEffortSupport(
        buildModel(["xhigh", "low", "low", "ultra", "medium"]),
      ),
    ).toEqual(["low", "medium", "xhigh"])
  })

  test("uses explicit effort before configured default", () => {
    const model = buildModel(["low", "medium", "high", "xhigh"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: "max",
        requestModel: "gpt-test",
        targetModel: model,
        defaultEffortResolver: () => "low",
      }),
    ).toBe("xhigh")
  })

  test("uses configured default when explicit effort is omitted or invalid", () => {
    const model = buildModel(["low", "medium"])

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: undefined,
        requestModel: "gpt-test",
        targetModel: model,
        defaultEffortResolver: () => "high",
      }),
    ).toBe("medium")

    expect(
      resolveReasoningEffortForTarget({
        explicitEffort: "ultra",
        requestModel: "gpt-test",
        targetModel: model,
        defaultEffortResolver: () => "high",
      }),
    ).toBe("medium")
  })
})
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run:

```bash
bun test tests/reasoning-effort.test.ts
```

Expected: FAIL with a module resolution error for `~/lib/reasoning-effort`.

- [ ] **Step 3: Add the helper implementation**

Create `src/lib/reasoning-effort.ts`:

```ts
import type { Model } from "~/services/copilot/get-models"

import { getReasoningEffortForModel } from "~/lib/config"

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

const REASONING_EFFORT_RANKS = new Map<ReasoningEffort, number>(
  REASONING_EFFORTS.map((effort, index) => [effort, index]),
)

export function parseReasoningEffort(
  value: unknown,
): ReasoningEffort | undefined {
  if (typeof value !== "string") return undefined
  return REASONING_EFFORT_RANKS.has(value as ReasoningEffort) ?
      (value as ReasoningEffort)
    : undefined
}

export function getReasoningEffortSupport(
  model: Pick<Model, "capabilities"> | undefined,
): Array<ReasoningEffort> | undefined {
  const rawSupport = model?.capabilities.supports.reasoning_effort
  if (!Array.isArray(rawSupport)) return undefined

  const seen = new Set<ReasoningEffort>()
  for (const item of rawSupport) {
    const effort = parseReasoningEffort(item)
    if (effort) seen.add(effort)
  }

  const support = [...seen].sort(
    (left, right) =>
      (REASONING_EFFORT_RANKS.get(left) ?? 0)
      - (REASONING_EFFORT_RANKS.get(right) ?? 0),
  )

  return support.length > 0 ? support : undefined
}

export function normalizeReasoningEffortForSupport(
  intent: unknown,
  rawSupport: ReadonlyArray<string> | undefined,
): ReasoningEffort | undefined {
  const requested = parseReasoningEffort(intent)
  if (!requested) return undefined

  const support = getReasoningEffortSupport({
    capabilities: {
      family: "",
      limits: {},
      object: "",
      supports: {
        reasoning_effort: rawSupport ? [...rawSupport] : undefined,
      },
      tokenizer: "",
      type: "",
    },
  })
  if (!support) return undefined

  if (support.includes(requested)) return requested

  const requestedRank = REASONING_EFFORT_RANKS.get(requested) ?? 0
  let best = support[0]
  let bestDistance = Number.POSITIVE_INFINITY
  let bestRank = REASONING_EFFORT_RANKS.get(best) ?? 0

  for (const candidate of support) {
    const candidateRank = REASONING_EFFORT_RANKS.get(candidate) ?? 0
    const distance = Math.abs(candidateRank - requestedRank)
    if (
      distance < bestDistance
      || (distance === bestDistance && candidateRank < bestRank)
    ) {
      best = candidate
      bestDistance = distance
      bestRank = candidateRank
    }
  }

  return best
}

export function resolveReasoningEffortForTarget(params: {
  explicitEffort: unknown
  requestModel: string
  targetModel: Pick<Model, "capabilities"> | undefined
  defaultEffortResolver?: (model: string) => ReasoningEffort
}): ReasoningEffort | undefined {
  const explicit = parseReasoningEffort(params.explicitEffort)
  const defaultEffortResolver =
    params.defaultEffortResolver ?? getReasoningEffortForModel
  const intent = explicit ?? defaultEffortResolver(params.requestModel)

  return normalizeReasoningEffortForSupport(
    intent,
    params.targetModel?.capabilities.supports.reasoning_effort,
  )
}
```

- [ ] **Step 4: Run the helper test and verify it passes**

Run:

```bash
bun test tests/reasoning-effort.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the helper**

```bash
git add src/lib/reasoning-effort.ts tests/reasoning-effort.test.ts
git commit -m "feat: add reasoning effort normalization helper"
```

---

### Task 2: Admin Config And Model Detail Metadata

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/routes/admin-api/route.ts`
- Modify: `admin-ui/src/lib/admin-api.ts`
- Modify: `tests/admin-config.test.ts`
- Modify: `tests/admin-models-details.test.ts`

- [ ] **Step 1: Write failing Admin API tests**

In `tests/admin-config.test.ts`, replace the existing test named `POST /api/admin/config keeps reasoning max out of config layer` with:

```ts
test("POST /api/admin/config accepts max reasoning effort as intent", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelReasoningEfforts: {
            "gpt-5.5": "max",
          },
        }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      modelReasoningEfforts?: Record<string, string>
    }
    expect(body.modelReasoningEfforts?.["gpt-5.5"]).toBe("max")
  })
})
```

In `tests/admin-models-details.test.ts`, update the `gpt-5-mini` override object in the first test so it includes reasoning support:

```ts
capabilities: {
  family: "test",
  limits: {
    max_context_window_tokens: 128_000,
    max_prompt_tokens: 96_000,
    max_output_tokens: 32_000,
  },
  object: "capabilities",
  supports: {
    tool_calls: true,
    vision: false,
    structured_outputs: true,
    streaming: true,
    parallel_tool_calls: true,
    reasoning_effort: ["low", "medium", "high", "xhigh"],
  },
  tokenizer: "test",
  type: "chat",
},
```

Then update the local response type and assertion in that same test:

```ts
capabilities: {
  limits: {
    max_context_window_tokens?: number
    max_prompt_tokens?: number
    max_output_tokens?: number
  }
  supports: {
    tool_calls?: boolean
    reasoning_effort?: Array<string>
  }
}
```

```ts
expect(mini?.capabilities.supports.reasoning_effort).toEqual([
  "low",
  "medium",
  "high",
  "xhigh",
])
```

- [ ] **Step 2: Run the Admin API tests and verify they fail**

Run:

```bash
bun test tests/admin-config.test.ts tests/admin-models-details.test.ts
```

Expected: FAIL. The config test should reject `max`, and the model details test should not see `reasoning_effort`.

- [ ] **Step 3: Allow `max` in config types and validation**

In `src/lib/config.ts`, change the `modelReasoningEfforts` type to:

```ts
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >
```

In the same file, update `getReasoningEffortForModel()` so its return type also includes `max`:

```ts
export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
```

In `src/routes/admin-api/route.ts`, change the local `ReasoningEffort` type and set:

```ts
type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
```

```ts
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
```

In `admin-ui/src/lib/admin-api.ts`, change the exported `ReasoningEffort` type to:

```ts
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
```

- [ ] **Step 4: Expose `reasoning_effort` in Admin model details**

In `src/routes/admin-api/route.ts`, update `AdminModelDetailsItem["capabilities"]["supports"]`:

```ts
    supports: {
      tool_calls?: boolean
      parallel_tool_calls?: boolean
      structured_outputs?: boolean
      streaming?: boolean
      vision?: boolean
      reasoning_effort?: Array<string>
    }
```

In `parseCapabilities()`, add this property:

```ts
      reasoning_effort: parseStringArray(supportsRaw?.reasoning_effort),
```

In `admin-ui/src/lib/admin-api.ts`, update `AdminModelDetailsItem["capabilities"]["supports"]`:

```ts
    supports: {
      tool_calls?: boolean
      parallel_tool_calls?: boolean
      structured_outputs?: boolean
      streaming?: boolean
      vision?: boolean
      reasoning_effort?: Array<string>
    }
```

- [ ] **Step 5: Run the Admin API tests and verify they pass**

Run:

```bash
bun test tests/admin-config.test.ts tests/admin-models-details.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Admin metadata support**

```bash
git add src/lib/config.ts src/routes/admin-api/route.ts admin-ui/src/lib/admin-api.ts tests/admin-config.test.ts tests/admin-models-details.test.ts
git commit -m "feat: expose model reasoning effort support"
```

---

### Task 3: Direct Responses And Chat Completions Routes

**Files:**
- Modify: `src/services/copilot/create-chat-completions.ts`
- Modify: `src/services/copilot/create-responses.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `tests/chat-completions-handler.test.ts`
- Modify: `tests/responses-handler.test.ts`
- Modify: `tests/create-chat-completions.test.ts`

- [ ] **Step 1: Write failing Chat Completions route tests**

In `tests/chat-completions-handler.test.ts`, change `buildModel()` to accept support:

```ts
function buildModel(
  id: string,
  reasoningEffort: Array<string> = ["low", "medium", "high", "xhigh"],
): Model {
  return {
    id,
    name: id,
    vendor: "upstream",
    object: "model",
    preview: false,
    version: "test",
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      limits: {
        max_output_tokens: 8192,
        max_prompt_tokens: 200_000,
      },
      object: "capabilities",
      supports: {
        adaptive_thinking: true,
        streaming: true,
        reasoning_effort: reasoningEffort,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}
```

Change `buildSelection()` to pass support through:

```ts
function buildSelection(
  modelId: string,
  reasoningEffort?: Array<string>,
): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel(modelId, reasoningEffort),
    endpoint: "/chat/completions",
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    affinityHit: false,
    selectionReason: "affinity_miss",
  }
}
```

Add these tests inside the `describe("chat completions handler", () => {` block before its closing `})`:

```ts
test("normalizes explicit reasoning_effort to selected model support", async () => {
  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("gpt-test", ["low", "medium", "high"]))

  let upstreamBody: Record<string, unknown> | undefined
  fetchMock.mockImplementationOnce((_url, opts) => {
    upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "gpt-test",
          choices: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  })

  const app = createApp()
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "max",
    }),
  })

  expect(response.status).toBe(200)
  expect(upstreamBody?.reasoning_effort).toBe("high")
})

test("injects configured fallback effort for any supported chat model", async () => {
  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("gpt-test", ["low", "medium"]))

  let upstreamBody: Record<string, unknown> | undefined
  fetchMock.mockImplementationOnce((_url, opts) => {
    upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "gpt-test",
          choices: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  })

  const app = createApp()
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.status).toBe(200)
  expect(upstreamBody?.reasoning_effort).toBe("medium")
})
```

- [ ] **Step 2: Write failing Responses route tests**

In `tests/responses-handler.test.ts`, change `buildModel()` so it accepts support:

```ts
function buildModel(
  id: string,
  maxPromptImageSize?: number,
  reasoningEffort: Array<string> = ["low", "medium", "high", "xhigh"],
): Model {
  return {
    id,
    name: id,
    vendor: "upstream",
    object: "model",
    preview: false,
    version: "test",
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      limits: {
        max_output_tokens: 8192,
        max_prompt_tokens: 200_000,
        ...(maxPromptImageSize !== undefined ?
          { vision: { max_prompt_image_size: maxPromptImageSize } }
        : {}),
      },
      object: "capabilities",
      supports: {
        adaptive_thinking: true,
        streaming: true,
        vision: maxPromptImageSize !== undefined ? true : undefined,
        reasoning_effort: reasoningEffort,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}
```

Change `buildSelection()` to pass support through:

```ts
function buildSelection(
  endpoint: string,
  modelId: string,
  reasoningEffort?: Array<string>,
): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel(modelId, undefined, reasoningEffort),
    endpoint,
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    affinityHit: false,
    affinityCacheKey: "test-cache-key",
    selectionReason: "affinity_miss",
  }
}
```

Add these tests:

```ts
test("normalizes explicit Responses reasoning effort to selected model support", async () => {
  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/responses", "gpt-test", ["low", "high"]))

  let upstreamBody: Record<string, unknown> | undefined
  fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
    upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
    return Promise.resolve(
      new Response(JSON.stringify(buildResponsesResult("gpt-test", "ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }) as unknown as typeof fetch

  const response = await responsesRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: "hello",
        reasoning: { effort: "medium" },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe("low")
})

test("injects configured fallback effort for supported Responses models", async () => {
  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/responses", "gpt-test", ["low", "medium"]))

  let upstreamBody: Record<string, unknown> | undefined
  fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
    upstreamBody = JSON.parse(String(opts?.body)) as Record<string, unknown>
    return Promise.resolve(
      new Response(JSON.stringify(buildResponsesResult("gpt-test", "ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }) as unknown as typeof fetch

  const response = await responsesRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: "hello",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe(
    "medium",
  )
})
```

- [ ] **Step 3: Run route tests and verify they fail**

Run:

```bash
bun test tests/chat-completions-handler.test.ts tests/responses-handler.test.ts
```

Expected: FAIL because direct route handlers do not yet normalize or inject these fields.

- [ ] **Step 4: Apply normalization in Chat Completions handler and remove service special case**

In `src/services/copilot/create-chat-completions.ts`, remove:

```ts
import { getReasoningEffortForModel, isForceAgentEnabled } from "~/lib/config"
```

Replace it with:

```ts
import { isForceAgentEnabled } from "~/lib/config"
```

Delete `isGpt5MiniFamily()` and `applyDefaultReasoningEffort()`.

Replace:

```ts
  const upstreamPayload = applyDefaultReasoningEffort(payload)
```

with:

```ts
  const upstreamPayload = payload
```

In `src/routes/chat-completions/handler.ts`, import the helper:

```ts
import { resolveReasoningEffortForTarget } from "~/lib/reasoning-effort"
```

Before `await logTokenCountForRequest({ payload: upstreamPayload, selectedModel })`, replace the `const upstreamPayload` declaration with:

```ts
  const upstreamPayload = { ...payload, model: selectedModel.id }
  const reasoningEffort = resolveReasoningEffortForTarget({
    explicitEffort: payload.reasoning_effort,
    requestModel: clientModel,
    targetModel: selectedModel,
  })
  if (reasoningEffort) {
    upstreamPayload.reasoning_effort = reasoningEffort
  } else {
    delete upstreamPayload.reasoning_effort
  }
```

- [ ] **Step 5: Apply normalization in Responses handler and type**

In `src/services/copilot/create-responses.ts`, update `Reasoning.effort`:

```ts
  effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | null
```

In `src/routes/responses/handler.ts`, import:

```ts
import { resolveReasoningEffortForTarget } from "~/lib/reasoning-effort"
```

Replace:

```ts
  const upstreamPayload = { ...payload, model: selectedModel.id }
```

with:

```ts
  const upstreamPayload = { ...payload, model: selectedModel.id }
  const reasoningEffort = resolveReasoningEffortForTarget({
    explicitEffort: payload.reasoning?.effort,
    requestModel: clientModel,
    targetModel: selectedModel,
  })
  if (reasoningEffort) {
    upstreamPayload.reasoning = {
      ...(upstreamPayload.reasoning ?? {}),
      effort: reasoningEffort,
    }
  } else if (upstreamPayload.reasoning) {
    delete upstreamPayload.reasoning.effort
  }
```

- [ ] **Step 6: Update old service-level Chat Completions tests**

In `tests/create-chat-completions.test.ts`, remove the complete test blocks named `injects reasoning_effort from config for gpt-5-mini when omitted` and `injects reasoning_effort for gpt-5-mini variant models when omitted` because route-level normalization replaces the service special case.

Keep and rename the explicit pass-through tests so service behavior stays simple:

```ts
test("passes through explicit reasoning_effort unchanged", async () => {
  const callCountBefore = fetchMock.mock.calls.length

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5-mini",
    reasoning_effort: "high",
  }

  await callCreateChatCompletions(payload)

  expect(fetchMock.mock.calls.length).toBe(callCountBefore + 1)
  const upstreamPayload = getLastUpstreamPayload()
  expect(upstreamPayload["reasoning_effort"]).toBe("high")
})
```

- [ ] **Step 7: Run direct route and service tests**

Run:

```bash
bun test tests/chat-completions-handler.test.ts tests/responses-handler.test.ts tests/create-chat-completions.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit direct route normalization**

```bash
git add src/services/copilot/create-chat-completions.ts src/services/copilot/create-responses.ts src/routes/chat-completions/handler.ts src/routes/responses/handler.ts tests/chat-completions-handler.test.ts tests/responses-handler.test.ts tests/create-chat-completions.test.ts
git commit -m "feat: normalize direct reasoning efforts"
```

---

### Task 4: Messages Route And Translation Normalization

**Files:**
- Modify: `src/routes/messages/preprocess.ts`
- Modify: `src/routes/messages/responses-translation.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `tests/messages-handler.test.ts`

- [ ] **Step 1: Write failing Messages route tests**

In `tests/messages-handler.test.ts`, change `buildModel()` to accept support:

```ts
function buildModel(
  id: string,
  reasoningEffort: Array<string> = ["low", "medium", "high", "xhigh"],
): Model {
  return {
    id,
    name: id,
    vendor: "upstream",
    object: "model",
    preview: false,
    version: "test",
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      limits: {
        max_output_tokens: 8192,
        max_prompt_tokens: 200_000,
      },
      object: "capabilities",
      supports: {
        adaptive_thinking: true,
        streaming: true,
        reasoning_effort: reasoningEffort,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}
```

Change `buildSelection()`:

```ts
function buildSelection(
  endpoint: string,
  modelId: string,
  reasoningEffort?: Array<string>,
): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel(modelId, reasoningEffort),
    endpoint,
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    confirmOwnership: mock(() => {}),
    affinityHit: false,
    selectionReason: "affinity_miss",
  }
}
```

Add tests:

```ts
test("Messages to Responses preserves explicit effort as normalized intent", async () => {
  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/responses", "responses-model", ["low", "high"]))

  let upstreamBody: Record<string, unknown> | undefined
  fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
    upstreamBody = parseFetchBody(opts?.body)
    return Promise.resolve(
      new Response(
        JSON.stringify(buildResponsesResult("responses-model", "responses")),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  }) as unknown as typeof fetch

  const response = await messageRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createPayload({
          output_config: {
            effort: "medium",
          },
        }),
      ),
    }),
  )

  expect(response.status).toBe(200)
  expect((upstreamBody?.reasoning as { effort?: string }).effort).toBe("low")
})

test("Messages to native Messages injects default effort when omitted", async () => {
  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/v1/messages", "messages-model", ["low", "medium"]))

  let upstreamBody: Record<string, unknown> | undefined
  fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
    upstreamBody = parseFetchBody(opts?.body)
    return Promise.resolve(
      new Response(
        JSON.stringify(buildAnthropicResponse("messages-model", "messages")),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  }) as unknown as typeof fetch

  const response = await messageRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createPayload()),
    }),
  )

  expect(response.status).toBe(200)
  expect((upstreamBody?.output_config as { effort?: string }).effort).toBe(
    "medium",
  )
})

test("Messages to Chat Completions writes normalized reasoning_effort", async () => {
  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/chat/completions", "chat-model", ["low", "high"]))

  let upstreamBody: Record<string, unknown> | undefined
  fetchHolder.fetch = mock((_url: string, opts?: FetchOptions) => {
    upstreamBody = parseFetchBody(opts?.body)
    return Promise.resolve(
      new Response(
        JSON.stringify(buildChatCompletionResponse("chat-model", "chat")),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  }) as unknown as typeof fetch

  const response = await messageRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createPayload({
          output_config: {
            effort: "medium",
          },
        }),
      ),
    }),
  )

  expect(response.status).toBe(200)
  expect(upstreamBody?.reasoning_effort).toBe("low")
})
```

- [ ] **Step 2: Run Messages tests and verify they fail**

Run:

```bash
bun test tests/messages-handler.test.ts
```

Expected: FAIL because `/responses` still uses config unconditionally and native Messages/Chat paths do not yet share final-model normalization.

- [ ] **Step 3: Update native Messages preprocessing**

In `src/routes/messages/preprocess.ts`, replace the `getReasoningEffortForModel` import with:

```ts
import { resolveReasoningEffortForTarget } from "~/lib/reasoning-effort"
```

Inside the adaptive thinking block, replace:

```ts
    let effort =
      payload.output_config?.effort ?? getReasoningEffortForModel(payload.model)
    if (effort === "none" || effort === "minimal") {
      effort = "low"
    }
    const reasoningEffort = selectedModel.capabilities.supports.reasoning_effort
    if (reasoningEffort && !reasoningEffort.includes(effort)) {
      effort = reasoningEffort.at(-1) as "low" | "medium" | "high"
    }
    payload.output_config = {
      effort: effort,
    }
```

with:

```ts
    let effort = resolveReasoningEffortForTarget({
      explicitEffort: payload.output_config?.effort,
      requestModel: payload.model,
      targetModel: selectedModel,
    })
    if (effort === "none" || effort === "minimal") {
      effort = "low"
    }
    if (effort) {
      payload.output_config = {
        ...payload.output_config,
        effort,
      }
    } else if (payload.output_config) {
      delete payload.output_config.effort
      if (Object.keys(payload.output_config).length === 0) {
        delete payload.output_config
      }
    }
```

- [ ] **Step 4: Update Messages to Responses translation options**

In `src/routes/messages/responses-translation.ts`, remove the `getReasoningEffortForModel` import and import the type:

```ts
import type { ReasoningEffort } from "~/lib/reasoning-effort"
```

Extend the options type for `translateAnthropicMessagesToResponsesPayload()`:

```ts
  reasoningEffort?: ReasoningEffort
```

In the returned `responsesPayload`, replace:

```ts
    reasoning: {
      effort: getReasoningEffortForModel(model),
      summary: "auto",
    },
```

with:

```ts
    reasoning: options.reasoningEffort ?
      {
        effort: options.reasoningEffort,
        summary: "auto",
      }
    : {
        summary: "auto",
      },
```

- [ ] **Step 5: Normalize in Messages handler after selection**

In `src/routes/messages/handler.ts`, import:

```ts
import { resolveReasoningEffortForTarget } from "~/lib/reasoning-effort"
```

In `handleWithChatCompletions()`, before logging the payload, insert:

```ts
  const reasoningEffort = resolveReasoningEffortForTarget({
    explicitEffort: openAIPayload.reasoning_effort,
    requestModel: instr.clientModel,
    targetModel: selectedModel,
  })
  if (reasoningEffort) {
    openAIPayload.reasoning_effort = reasoningEffort
  } else {
    delete openAIPayload.reasoning_effort
  }
```

In `handleWithResponsesApi()`, compute normalized effort before translation:

```ts
  const reasoningEffort = resolveReasoningEffortForTarget({
    explicitEffort: anthropicPayload.output_config?.effort,
    requestModel: instr.clientModel,
    targetModel: selectedModel,
  })
```

Then pass it into translation:

```ts
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    {
      modelOverride: selectedModel.id,
      subagentAgentId: subagentMarker?.agent_id,
      reasoningEffort,
    },
  )
```

- [ ] **Step 6: Run Messages tests and verify they pass**

Run:

```bash
bun test tests/messages-handler.test.ts tests/messages-preprocess.test.ts tests/responses-translation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Messages normalization**

```bash
git add src/routes/messages/preprocess.ts src/routes/messages/responses-translation.ts src/routes/messages/handler.ts tests/messages-handler.test.ts
git commit -m "feat: normalize messages reasoning efforts"
```

---

### Task 5: Admin UI Model-Specific Reasoning Options

**Files:**
- Modify: `admin-ui/src/lib/admin-api.ts`
- Modify: `admin-ui/src/pages/settings-page.tsx`
- Modify: `admin-ui/tests/settings-page.test.tsx`

- [ ] **Step 1: Write failing Admin UI tests**

In `admin-ui/tests/settings-page.test.tsx`, update the import:

```ts
import {
  ModelMappingsCard,
  ReasoningEffortsCard,
  ResponsesApiSettingsCard,
  compactThresholdRecordFromItems,
  createQuickProviderItem,
  deriveProviderModelSuggestions,
  getUniqueProviderName,
  parseCompactThresholdsJson,
  parseModelMappingsJson,
  parseReasoningJson,
} from "../src/pages/settings-page"
```

Add tests:

```tsx
test("reasoning editor renders model-specific effort choices", () => {
  const html = renderToStaticMarkup(
    <ReasoningEffortsCard
      mode="form"
      json="{}"
      jsonIssue={null}
      items={[{ id: "reasoning-1", model: "gpt-5-mini", effort: "low" }]}
      models={["gpt-5-mini"]}
      reasoningSupportByModel={{
        "gpt-5-mini": {
          efforts: ["low", "medium"],
        },
      }}
      onToggleMode={() => {}}
      onJsonChange={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
      onUpdateItem={() => {}}
    />,
  )

  expect(html).toContain("gpt-5-mini")
  expect(html).toContain("low")
  expect(html).toContain("medium")
  expect(html).not.toContain("xhigh")
})

test("reasoning editor shows alias support inherited from target", () => {
  const html = renderToStaticMarkup(
    <ReasoningEffortsCard
      mode="form"
      json="{}"
      jsonIssue={null}
      items={[{ id: "reasoning-1", model: "fast", effort: "xhigh" }]}
      models={["fast"]}
      reasoningSupportByModel={{
        fast: {
          efforts: ["high", "xhigh"],
          target: "gpt-5.4",
        },
      }}
      onToggleMode={() => {}}
      onJsonChange={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
      onUpdateItem={() => {}}
    />,
  )

  expect(html).toContain("fast")
  expect(html).toContain("gpt-5.4")
  expect(html).toContain("high")
  expect(html).toContain("xhigh")
})

test("reasoning JSON validation accepts max", () => {
  expect(parseReasoningJson('{ "gpt-5.5": "max" }')).toEqual({
    value: {
      "gpt-5.5": "max",
    },
  })
})
```

- [ ] **Step 2: Run Admin UI tests and verify they fail**

Run:

```bash
cd admin-ui && bun test tests/settings-page.test.tsx
```

Expected: FAIL because `ReasoningEffortsCard` and `parseReasoningJson` are not exported, `max` is not valid in the UI type, and the card does not accept `reasoningSupportByModel`.

- [ ] **Step 3: Add UI support types and `max`**

In `admin-ui/src/pages/settings-page.tsx`, update `REASONING_EFFORTS`:

```ts
const REASONING_EFFORTS: Array<ReasoningEffort> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]
```

Add this type near `ReasoningItem`:

```ts
type ReasoningSupportInfo = {
  efforts: Array<ReasoningEffort>
  target?: string
}
```

Export `parseReasoningJson`:

```ts
export function parseReasoningJson(
  value: string,
): ParseResult<Record<string, ReasoningEffort>> {
```

Export `ReasoningEffortsCard`:

```ts
export function ReasoningEffortsCard({
```

- [ ] **Step 4: Derive model and alias support from model details**

In `admin-ui/src/pages/settings-page.tsx`, import `getAdminModelDetails` and `AdminModelDetailsItem` from the Admin API module:

```ts
  getAdminModelDetails,
  type AdminModelDetailsItem,
```

Add this helper near other pure helpers:

```ts
function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
}

export function deriveReasoningSupportByModel(
  details: Array<AdminModelDetailsItem>,
): Record<string, ReasoningSupportInfo> {
  const support: Record<string, ReasoningSupportInfo> = {}

  for (const model of details) {
    const efforts =
      model.capabilities.supports.reasoning_effort?.filter(isReasoningEffort)
      ?? []
    if (efforts.length === 0) continue

    support[model.id] = { efforts }
    for (const alias of model.aliases) {
      support[alias] = {
        efforts,
        target: model.id,
      }
    }
  }

  return support
}
```

In `SettingsPage`, add state:

```ts
  const [reasoningSupportByModel, setReasoningSupportByModel] = useState<
    Record<string, ReasoningSupportInfo>
  >({})
```

In `load`, include model details:

```ts
      const [configRes, modelsRes, modelDetailsRes, devModeRes] =
        await Promise.allSettled([
          getAdminConfig(),
          getAdminModels(),
          getAdminModelDetails(),
          getDevMode(),
        ])
```

After handling `modelsRes`, handle `modelDetailsRes`:

```ts
      if (modelDetailsRes.status === "fulfilled") {
        setReasoningSupportByModel(
          deriveReasoningSupportByModel(modelDetailsRes.value.items),
        )
      } else {
        setReasoningSupportByModel({})
        toast.error(i18n.t("settingsPage.toast.loadModelsFailed"), {
          description:
            modelDetailsRes.reason instanceof Error ?
              modelDetailsRes.reason.message
            : String(modelDetailsRes.reason),
        })
      }
```

- [ ] **Step 5: Render model-specific options in the reasoning card**

Extend `ReasoningEffortsCardProps`:

```ts
  reasoningSupportByModel?: Record<string, ReasoningSupportInfo>
```

Accept the prop with a default:

```ts
  reasoningSupportByModel = {},
```

Inside the `items.map((item) => {` callback before the `return (` statement, derive options:

```ts
                const supportInfo =
                  modelValue !== defaultModelValue ?
                    reasoningSupportByModel[modelValue]
                  : undefined
                const supportedEfforts =
                  supportInfo?.efforts.length ? supportInfo.efforts : REASONING_EFFORTS
                const showUnsupportedConfiguredEffort =
                  item.effort && !supportedEfforts.includes(item.effort)
                const effortOptions =
                  showUnsupportedConfiguredEffort ?
                    [item.effort, ...supportedEfforts]
                  : supportedEfforts
```

Replace the effort `SelectContent` mapping with:

```tsx
                        <SelectContent>
                          {effortOptions.map((effort) => (
                            <SelectItem key={effort} value={effort}>
                              {effort}
                            </SelectItem>
                          ))}
                        </SelectContent>
```

Below the row controls, before the existing item hint, render alias/support hints:

```tsx
                      {supportInfo?.target ? (
                        <div className="text-muted-foreground text-xs">
                          {`Uses ${supportInfo.target} reasoning options.`}
                        </div>
                      ) : null}
                      {modelValue !== defaultModelValue && !supportInfo ? (
                        <InlineAlert
                          variant="warning"
                          title="No reasoning effort metadata"
                          description="This model does not currently advertise reasoning effort support."
                        />
                      ) : null}
                      {showUnsupportedConfiguredEffort ? (
                        <InlineAlert
                          variant="warning"
                          title="Effort will be normalized"
                          description={`${item.effort} is kept as intent and normalized at runtime.`}
                        />
                      ) : null}
```

When rendering `ReasoningEffortsCard` inside `SettingsPage`, pass:

```tsx
              reasoningSupportByModel={reasoningSupportByModel}
```

- [ ] **Step 6: Run Admin UI tests**

Run:

```bash
cd admin-ui && bun test tests/settings-page.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Admin UI reasoning options**

```bash
git add admin-ui/src/lib/admin-api.ts admin-ui/src/pages/settings-page.tsx admin-ui/tests/settings-page.test.tsx
git commit -m "feat: show model reasoning effort options"
```

---

### Task 6: Full Verification And Cleanup

**Files:**
- Verify all files changed in Tasks 1-5.
- Update tests only if TypeScript reveals exact type mismatches introduced by earlier tasks.

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
bun test tests/reasoning-effort.test.ts tests/admin-config.test.ts tests/admin-models-details.test.ts tests/chat-completions-handler.test.ts tests/responses-handler.test.ts tests/messages-handler.test.ts tests/messages-preprocess.test.ts tests/responses-translation.test.ts tests/create-chat-completions.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run targeted Admin UI tests**

Run:

```bash
cd admin-ui && bun test tests/settings-page.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat HEAD
git diff --check
```

Expected: `git diff --check` exits 0 with no whitespace errors.

- [ ] **Step 6: Commit final cleanup if any files changed after Task 5**

If Step 1-5 required edits after the Task 5 commit, commit only those edits:

```bash
git add src/lib/reasoning-effort.ts src/lib/config.ts src/routes/admin-api/route.ts src/services/copilot/create-chat-completions.ts src/services/copilot/create-responses.ts src/routes/chat-completions/handler.ts src/routes/responses/handler.ts src/routes/messages/preprocess.ts src/routes/messages/responses-translation.ts src/routes/messages/handler.ts admin-ui/src/lib/admin-api.ts admin-ui/src/pages/settings-page.tsx tests/reasoning-effort.test.ts tests/admin-config.test.ts tests/admin-models-details.test.ts tests/chat-completions-handler.test.ts tests/responses-handler.test.ts tests/messages-handler.test.ts tests/create-chat-completions.test.ts admin-ui/tests/settings-page.test.tsx
git commit -m "chore: finalize reasoning effort normalization"
```

If no files changed during Task 6, skip this commit.
