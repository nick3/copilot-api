# Admin-UI 设置页优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not create git commits unless the user explicitly asks for commits.

**Goal:** Admin-UI 能配置 `useResponsesApiContextManagement`，并把 Responses API 相关设置集中到独立 section，同时保留旧配置兼容与测试覆盖。

**Architecture:** 后端沿用现有 Admin config patch pipeline，只把新 boolean 字段加入白名单和 handler。前端新增 `ResponsesApiSettingsCard` 并新增 `responsesApi` section，复用现有 compact threshold editor 与 legacy textarea 状态，不引入 schema-driven 表单或新表单库。

**Tech Stack:** Bun test runner、TypeScript strict、React 19、react-i18next、Hono Admin API、现有 shadcn-style UI components。

---

## File Structure

### Backend

- Modify: `src/routes/admin-api/route.ts`
  - Add `useResponsesApiContextManagement` to `CONFIG_KEYS`.
  - Extend `applyOptionalBoolean()` accepted key union.
  - Add a `CONFIG_PATCH_HANDLERS` entry using existing boolean parser semantics.
- Modify: `tests/admin-config.test.ts`
  - Add Admin API tests for false, true, null clear, and invalid type.

### Runtime behavior tests

- Modify: `tests/responses-handler.test.ts`
  - Add tests under `describe("responses handler context management", ...)` using `responsesUtilsDependencies` to force enabled/disabled states.
  - Restore dependency overrides in `afterEach()`.

### Frontend API typing

- Modify: `admin-ui/src/lib/admin-api.ts`
  - Add `useResponsesApiContextManagement?: boolean` to `AdminConfig`.
  - Add field to `ADMIN_CONFIG_KEYS` so `updateAdminConfig()` does not filter it.

### Frontend settings UI

- Modify: `admin-ui/src/pages/settings-page.tsx`
  - Add `responsesApi` section id.
  - Export new `ResponsesApiSettingsCard` for tests.
  - Move `useResponsesApiWebSocket`, `useResponsesApiWebSearch`, `useResponsesApiContextManagement`, `modelResponsesApiCompactThresholds`, and `responsesApiContextManagementModels` into the new card.
  - Keep `AdvancedSettingsCard` focused on routing/model/global advanced settings.
- Modify: `admin-ui/src/locales/en-US.json`
  - Add `settingsPage.sections.responsesApi`.
  - Add `settingsPage.responsesApi.*` copy.
  - Remove or stop using Responses API copy under `settingsPage.advanced.*` after UI migration.
- Modify: `admin-ui/src/locales/zh-CN.json`
  - Mirror English locale keys in Simplified Chinese.
- Modify: `admin-ui/tests/settings-page.test.tsx`
  - Update tests to render `ResponsesApiSettingsCard` instead of expecting Responses API controls inside `AdvancedSettingsCard`.

### Verification

- Run targeted tests:
  - `bun test tests/admin-config.test.ts tests/responses-handler.test.ts`
  - `bun test admin-ui/tests/settings-page.test.tsx`
- Run quality checks when targeted tests pass:
  - `bun run typecheck`
  - `bun run typecheck:admin`
  - `bun run lint`
  - `bun run lint:admin`

---

## Task 1: Backend Admin API accepts `useResponsesApiContextManagement`

**Files:**
- Modify: `src/routes/admin-api/route.ts`
- Test: `tests/admin-config.test.ts`

- [ ] **Step 1: Write failing Admin API tests**

Append these tests after the existing `responsesApiContextManagementModels` tests in `tests/admin-config.test.ts`:

```ts
test("POST /api/admin/config updates useResponsesApiContextManagement", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const falseRes = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useResponsesApiContextManagement: false }),
      }),
    )

    expect(falseRes.status).toBe(200)

    const falseBody = (await falseRes.json()) as {
      useResponsesApiContextManagement?: boolean
    }
    expect(falseBody.useResponsesApiContextManagement).toBe(false)

    const trueRes = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useResponsesApiContextManagement: true }),
      }),
    )

    expect(trueRes.status).toBe(200)

    const trueBody = (await trueRes.json()) as {
      useResponsesApiContextManagement?: boolean
    }
    expect(trueBody.useResponsesApiContextManagement).toBe(true)
  })
})

test("POST /api/admin/config clears useResponsesApiContextManagement to default", async () => {
  await withConfig({ useResponsesApiContextManagement: false }, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useResponsesApiContextManagement: null }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      useResponsesApiContextManagement?: boolean
    }
    expect(body.useResponsesApiContextManagement).toBe(true)
  })
})

test("POST /api/admin/config rejects invalid useResponsesApiContextManagement", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useResponsesApiContextManagement: "false" }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain(
      "useResponsesApiContextManagement must be a boolean",
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test tests/admin-config.test.ts
```

Expected before implementation:

- The new update/clear tests fail with `Unknown config key: useResponsesApiContextManagement`, or equivalent 400 response.
- Existing tests should still pass.

- [ ] **Step 3: Implement minimal backend support**

In `src/routes/admin-api/route.ts`, update `CONFIG_KEYS`:

```ts
const CONFIG_KEYS = new Set<keyof AppConfig>([
  "auth",
  "extraPrompts",
  "smallModel",
  "logLevel",
  "accountAffinity",
  "apiKey",
  "anthropicApiKey",
  "providers",
  "responsesApiContextManagementModels",
  "useResponsesApiContextManagement",
  "modelReasoningEfforts",
  "modelAliases",
  "allowOriginalModelNamesForAliases",
  "forceAgent",
  "compactUseSmallModel",
  "messageStartInputTokensFallback",
  "modelRefreshIntervalHours",
  "sessionAffinityRetentionDays",
  "useMessagesApi",
  "useResponsesApiWebSocket",
  "useResponsesApiWebSearch",
  "devMode",
  "quotaRefresh",
])
```

Extend the `applyOptionalBoolean()` key union:

```ts
function applyOptionalBoolean(
  next: AppConfig,
  key:
    | "accountAffinity"
    | "forceAgent"
    | "useMessagesApi"
    | "useResponsesApiWebSocket"
    | "useResponsesApiWebSearch"
    | "useResponsesApiContextManagement"
    | "compactUseSmallModel"
    | "messageStartInputTokensFallback"
    | "allowOriginalModelNamesForAliases",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalBoolean(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}
```

Add the patch handler near the other Responses API handlers:

```ts
const CONFIG_PATCH_HANDLERS: Partial<Record<string, ConfigPatchHandler>> = {
  auth: applyAuthConfig,
  extraPrompts: applyExtraPrompts,
  smallModel: (next, value) => applyOptionalString(next, "smallModel", value),
  logLevel: applyLogLevel,
  accountAffinity: (next, value) =>
    applyOptionalBoolean(next, "accountAffinity", value),
  apiKey: (next, value) => applyOptionalString(next, "apiKey", value),
  anthropicApiKey: (next, value) =>
    applyOptionalString(next, "anthropicApiKey", value),
  providers: applyProvidersConfig,
  responsesApiContextManagementModels: applyResponsesApiContextManagementModels,
  useResponsesApiContextManagement: (next, value) =>
    applyOptionalBoolean(next, "useResponsesApiContextManagement", value),
  modelReasoningEfforts: applyReasoningEfforts,
  modelAliases: applyModelAliases,
  allowOriginalModelNamesForAliases: (next, value) =>
    applyOptionalBoolean(next, "allowOriginalModelNamesForAliases", value),
  forceAgent: (next, value) => applyOptionalBoolean(next, "forceAgent", value),
  compactUseSmallModel: (next, value) =>
    applyOptionalBoolean(next, "compactUseSmallModel", value),
  messageStartInputTokensFallback: (next, value) =>
    applyOptionalBoolean(next, "messageStartInputTokensFallback", value),
  modelRefreshIntervalHours: (next, value) =>
    applyOptionalNumber(next, "modelRefreshIntervalHours", value),
  sessionAffinityRetentionDays: (next, value) =>
    applyOptionalNumber(next, "sessionAffinityRetentionDays", value),
  useMessagesApi: (next, value) =>
    applyOptionalBoolean(next, "useMessagesApi", value),
  useResponsesApiWebSocket: (next, value) =>
    applyOptionalBoolean(next, "useResponsesApiWebSocket", value),
  useResponsesApiWebSearch: (next, value) =>
    applyOptionalBoolean(next, "useResponsesApiWebSearch", value),
  devMode: applyDevModeConfig,
  quotaRefresh: applyQuotaRefreshConfig,
}
```

Keep surrounding existing entries not shown here if the file has changed. Do not add a new parser.

- [ ] **Step 4: Run Admin API tests**

Run:

```bash
bun test tests/admin-config.test.ts
```

Expected:

- PASS for all existing tests.
- PASS for the three new `useResponsesApiContextManagement` tests.

---

## Task 2: Runtime behavior is verified for enabled and disabled context management

**Files:**
- Modify: `tests/responses-handler.test.ts`

- [ ] **Step 1: Import Responses utils dependency override**

In `tests/responses-handler.test.ts`, extend the top-level `Promise.all` import tuple from:

```ts
const [
  { accountsManager },
  { getAdminDb },
  { state },
  { setModelMappings, setProviderConfig },
  { responsesRoutes },
] = await Promise.all([
  import("~/lib/accounts-manager"),
  import("~/lib/admin-db"),
  import("~/lib/state"),
  import("~/lib/config"),
  import("~/routes/responses/route"),
])
```

to:

```ts
const [
  { accountsManager },
  { getAdminDb },
  { state },
  { setModelMappings, setProviderConfig },
  { responsesRoutes },
  { responsesUtilsDependencies },
] = await Promise.all([
  import("~/lib/accounts-manager"),
  import("~/lib/admin-db"),
  import("~/lib/state"),
  import("~/lib/config"),
  import("~/routes/responses/route"),
  import("~/routes/responses/utils"),
])
```

After the existing `originalMarkFailed` constant, add originals for the dependency hooks:

```ts
const originalContextManagementEnabled =
  responsesUtilsDependencies.isResponsesApiContextManagementEnabled
const originalModelCompactThreshold =
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold
```

In `afterEach()`, restore them:

```ts
afterEach(() => {
  fetchHolder.fetch = originalFetch
  accountsManager.selectAccountForRequest = originalSelect
  accountsManager.finalizeQuota = originalFinalize
  accountsManager.markAccountFailed = originalMarkFailed

  responsesUtilsDependencies.isResponsesApiContextManagementEnabled =
    originalContextManagementEnabled
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold =
    originalModelCompactThreshold

  setModelMappings({})
  setProviderConfig("acme", { enabled: false })
})
```

- [ ] **Step 2: Add runtime tests**

Inside the existing `describe("responses handler context management", () => { ... })`, after the current compact threshold test, add:

```ts
test("does not add context_management when disabled", async () => {
  responsesUtilsDependencies.isResponsesApiContextManagementEnabled = () => false

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/responses", "gpt-5.4"))

  let forwardedPayload: ResponsesPayload | undefined
  const fetchMock = mock((_url: string, options?: FetchOptions) => {
    forwardedPayload = JSON.parse(options?.body as string) as ResponsesPayload
    return Promise.resolve(
      new Response(JSON.stringify(buildResponsesResult("gpt-5.4", "ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  })

  // @ts-expect-error test mock only implements the used subset
  fetchHolder.fetch = fetchMock

  const response = await responsesRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: "hello",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(forwardedPayload?.context_management).toBeUndefined()
})

test("preserves request-provided context_management", async () => {
  responsesUtilsDependencies.isResponsesApiContextManagementEnabled = () => true

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/responses", "gpt-5.4"))

  let forwardedPayload: ResponsesPayload | undefined
  const fetchMock = mock((_url: string, options?: FetchOptions) => {
    forwardedPayload = JSON.parse(options?.body as string) as ResponsesPayload
    return Promise.resolve(
      new Response(JSON.stringify(buildResponsesResult("gpt-5.4", "ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  })

  // @ts-expect-error test mock only implements the used subset
  fetchHolder.fetch = fetchMock

  const contextManagement = [
    {
      type: "compaction" as const,
      compact_threshold: 12345,
    },
  ]

  const response = await responsesRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: "hello",
        context_management: contextManagement,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(forwardedPayload?.context_management).toEqual(contextManagement)
})
```

- [ ] **Step 3: Run Responses handler tests**

Run:

```bash
bun test tests/responses-handler.test.ts
```

Expected:

- PASS for existing responses handler tests.
- PASS for the new disabled and preserve-request tests.

If TypeScript rejects the `contextManagement` literal shape, inline the array directly in `JSON.stringify()` and assert the numeric threshold:

```ts
expect(forwardedPayload?.context_management?.[0]?.compact_threshold).toBe(12345)
```

---

## Task 3: Frontend Admin API type and save whitelist include the new field

**Files:**
- Modify: `admin-ui/src/lib/admin-api.ts`

- [ ] **Step 1: Add frontend config type field**

In `admin-ui/src/lib/admin-api.ts`, update `AdminConfig` near the existing Responses API fields:

```ts
export type AdminConfig = {
  auth?: {
    apiKeys?: Array<string>
  }
  providers?: Record<string, ProviderConfig>
  extraPrompts?: Record<string, string>
  smallModel?: string
  accountAffinity?: boolean
  /** @deprecated */
  apiKey?: string
  anthropicApiKey?: string
  /** @deprecated use useResponsesApiContextManagement */
  responsesApiContextManagementModels?: Array<string>
  useResponsesApiContextManagement?: boolean
  modelReasoningEfforts?: Record<string, ReasoningEffort>
  modelResponsesApiCompactThresholds?: Record<string, number>
  modelAliases?: Record<string, ModelAliasSpec | string>
  allowOriginalModelNamesForAliases?: boolean
  forceAgent?: boolean
  compactUseSmallModel?: boolean
  messageStartInputTokensFallback?: boolean
  modelRefreshIntervalHours?: number
  sessionAffinityRetentionDays?: number
  useMessagesApi?: boolean
  useResponsesApiWebSocket?: boolean
  useResponsesApiWebSearch?: boolean
}
```

- [ ] **Step 2: Add field to frontend POST whitelist**

Update `ADMIN_CONFIG_KEYS`:

```ts
const ADMIN_CONFIG_KEYS = new Set<keyof AdminConfig>([
  "auth",
  "providers",
  "extraPrompts",
  "smallModel",
  "accountAffinity",
  "apiKey",
  "anthropicApiKey",
  "responsesApiContextManagementModels",
  "useResponsesApiContextManagement",
  "modelReasoningEfforts",
  "modelResponsesApiCompactThresholds",
  "modelAliases",
  "allowOriginalModelNamesForAliases",
  "forceAgent",
  "compactUseSmallModel",
  "messageStartInputTokensFallback",
  "modelRefreshIntervalHours",
  "sessionAffinityRetentionDays",
  "useMessagesApi",
  "useResponsesApiWebSocket",
  "useResponsesApiWebSearch",
])
```

- [ ] **Step 3: Run admin-ui typecheck**

Run:

```bash
bun run typecheck:admin
```

Expected:

- PASS.
- If later UI tasks are not implemented yet, this task should still pass because the type only adds an optional field.

---

## Task 4: Add `ResponsesApiSettingsCard` and move Responses API controls out of Advanced

**Files:**
- Modify: `admin-ui/src/pages/settings-page.tsx`

- [ ] **Step 1: Add the section id**

Update `SETTINGS_SECTION_IDS`:

```ts
const SETTINGS_SECTION_IDS = [
  "general",
  "reasoning",
  "responsesApi",
  "aliases",
  "prompts",
  "advanced",
  "providers",
  "devMode",
] as const
```

Remove `"compactThresholds"` from this list because compact thresholds move under Responses API.

- [ ] **Step 2: Extend `CompactThresholdsCard` props for inactive context**

Update `CompactThresholdsCardProps`:

```ts
type CompactThresholdsCardProps = {
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<CompactThresholdItem>
  models: Array<string>
  contextManagementEnabled?: boolean
  embedded?: boolean
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<CompactThresholdItem>) => void
}
```

Update the function signature:

```ts
function CompactThresholdsCard({
  mode,
  json,
  jsonIssue,
  items,
  models,
  contextManagementEnabled = true,
  embedded = false,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: CompactThresholdsCardProps): React.JSX.Element {
```

Inside the return, change the wrapper from a hard-coded `Card` to a conditional wrapper. Replace:

```tsx
return (
  <Card className="gap-4 py-4">
    <CardHeader className="px-4">
      <CardTitle>{t("settingsPage.compactThresholds.title")}</CardTitle>
      <CardDescription className="hidden sm:block">
        {t("settingsPage.compactThresholds.description")}
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3 px-4">
      ...
    </CardContent>
  </Card>
)
```

with this structure:

```tsx
const content = (
  <>
    {!contextManagementEnabled ? (
      <InlineAlert
        variant="warning"
        title={t("settingsPage.responsesApi.contextManagementInactiveTitle")}
        description={t("settingsPage.responsesApi.compactThresholdsInactiveHint")}
      />
    ) : null}
    <div className="flex items-center justify-between gap-3">
      <div className="text-muted-foreground text-xs">
        {t("settingsPage.compactThresholds.hint")}
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
        <Label className="text-muted-foreground text-xs">
          {t("settingsPage.common.jsonMode")}
        </Label>
      </div>
    </div>

    {mode === "json" ? (
      <div className="space-y-2">
        <Textarea
          value={json}
          onChange={(e) => onJsonChange(e.target.value)}
          className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
          placeholder={t("settingsPage.compactThresholds.jsonPlaceholder")}
        />
        {jsonIssue ? (
          <InlineAlert
            variant="warning"
            title={t("settingsPage.common.invalidJsonTitle")}
            description={jsonIssue}
          />
        ) : null}
      </div>
    ) : (
      <div className="space-y-2">
        {/* keep the existing form-mode body unchanged */}
      </div>
    )}
  </>
)

if (embedded) {
  return <div className="space-y-3">{content}</div>
}

return (
  <Card className="gap-4 py-4">
    <CardHeader className="px-4">
      <CardTitle>{t("settingsPage.compactThresholds.title")}</CardTitle>
      <CardDescription className="hidden sm:block">
        {t("settingsPage.compactThresholds.description")}
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3 px-4">{content}</CardContent>
  </Card>
)
```

When applying this step, move the existing form-mode body exactly as-is into the `content` fragment. Do not rewrite validation logic.

- [ ] **Step 3: Add `ResponsesApiSettingsCard` props and component**

Place this after `CompactThresholdsCard` and before `ExtraPromptsCard`:

```ts
type ResponsesApiSettingsCardProps = {
  useResponsesApiWebSocket: boolean
  useResponsesApiWebSearch: boolean
  useResponsesApiContextManagement: boolean
  responsesApiContextManagementModelsValue: string
  compactThresholdsMode: JsonMode
  compactThresholdsJson: string
  compactThresholdsJsonIssue: string | null
  compactThresholdsItems: Array<CompactThresholdItem>
  models: Array<string>
  onToggleUseResponsesApiWebSocket: (value: boolean) => void
  onToggleUseResponsesApiWebSearch: (value: boolean) => void
  onToggleUseResponsesApiContextManagement: (value: boolean) => void
  onResponsesApiContextManagementModelsChange: (value: string) => void
  onCompactThresholdsToggleMode: (next: boolean) => void
  onCompactThresholdsJsonChange: (value: string) => void
  onCompactThresholdsAddItem: () => void
  onCompactThresholdsRemoveItem: (id: string) => void
  onCompactThresholdsUpdateItem: (
    id: string,
    patch: Partial<CompactThresholdItem>,
  ) => void
}

export function ResponsesApiSettingsCard({
  useResponsesApiWebSocket,
  useResponsesApiWebSearch,
  useResponsesApiContextManagement,
  responsesApiContextManagementModelsValue,
  compactThresholdsMode,
  compactThresholdsJson,
  compactThresholdsJsonIssue,
  compactThresholdsItems,
  models,
  onToggleUseResponsesApiWebSocket,
  onToggleUseResponsesApiWebSearch,
  onToggleUseResponsesApiContextManagement,
  onResponsesApiContextManagementModelsChange,
  onCompactThresholdsToggleMode,
  onCompactThresholdsJsonChange,
  onCompactThresholdsAddItem,
  onCompactThresholdsRemoveItem,
  onCompactThresholdsUpdateItem,
}: ResponsesApiSettingsCardProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.responsesApi.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.responsesApi.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("settingsPage.responsesApi.transportGroupTitle")}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.responsesApi.useResponsesApiWebSocketLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.useResponsesApiWebSocketHint")}
            </div>
          </div>
          <Switch
            checked={useResponsesApiWebSocket}
            onCheckedChange={onToggleUseResponsesApiWebSocket}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.responsesApi.useResponsesApiWebSearchLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.useResponsesApiWebSearchHint")}
            </div>
          </div>
          <Switch
            checked={useResponsesApiWebSearch}
            onCheckedChange={onToggleUseResponsesApiWebSearch}
          />
        </div>

        <hr className="border-t" />
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("settingsPage.responsesApi.contextManagementGroupTitle")}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.responsesApi.useResponsesApiContextManagementLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.useResponsesApiContextManagementHint")}
            </div>
          </div>
          <Switch
            checked={useResponsesApiContextManagement}
            onCheckedChange={onToggleUseResponsesApiContextManagement}
          />
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.compactThresholds.title")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.compactThresholds.description")}
            </div>
          </div>
          <CompactThresholdsCard
            embedded
            contextManagementEnabled={useResponsesApiContextManagement}
            mode={compactThresholdsMode}
            json={compactThresholdsJson}
            jsonIssue={compactThresholdsJsonIssue}
            items={compactThresholdsItems}
            models={models}
            onToggleMode={onCompactThresholdsToggleMode}
            onJsonChange={onCompactThresholdsJsonChange}
            onAddItem={onCompactThresholdsAddItem}
            onRemoveItem={onCompactThresholdsRemoveItem}
            onUpdateItem={onCompactThresholdsUpdateItem}
          />
        </div>

        <hr className="border-t" />
        <div className="grid gap-2 rounded-lg border border-dashed p-3">
          <div className="space-y-1">
            <Label className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.responsesApiContextManagementModelsLabel")}
            </Label>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.responsesApi.responsesApiContextManagementModelsDeprecatedHint")}
            </div>
            {!useResponsesApiContextManagement ? (
              <div className="text-muted-foreground text-xs">
                {t("settingsPage.responsesApi.contextManagementInactiveHint")}
              </div>
            ) : null}
          </div>
          <Textarea
            autoComplete="off"
            placeholder={t(
              "settingsPage.responsesApi.responsesApiContextManagementModelsPlaceholder",
            )}
            value={responsesApiContextManagementModelsValue}
            onChange={(e) =>
              onResponsesApiContextManagementModelsChange(e.target.value)
            }
            className="min-h-[96px] font-mono text-xs"
          />
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Remove Responses API props from `AdvancedSettingsCard`**

In `AdvancedSettingsCardProps`, remove these fields:

```ts
useResponsesApiWebSocket: boolean
useResponsesApiWebSearch: boolean
responsesApiContextManagementModelsValue: string
onToggleUseResponsesApiWebSocket: (value: boolean) => void
onToggleUseResponsesApiWebSearch: (value: boolean) => void
onResponsesApiContextManagementModelsChange: (value: string) => void
```

In `AdvancedSettingsCard` parameters, remove the same names.

In the JSX body, remove the two switch blocks for:

- `settingsPage.advanced.useResponsesApiWebSocketLabel`
- `settingsPage.advanced.useResponsesApiWebSearchLabel`

Remove the textarea block for:

- `settingsPage.advanced.responsesApiContextManagementModelsLabel`

Keep `useMessagesApi` in Advanced.

- [ ] **Step 5: Extend `SettingsPageViewProps` and state return values**

In `SettingsPageViewProps`, add:

```ts
useResponsesApiContextManagement: boolean
onUseResponsesApiContextManagementToggle: (value: boolean) => void
```

Keep existing compact threshold props; they will now feed `ResponsesApiSettingsCard` instead of the standalone section.

In `useSettingsPageState()`, after existing `handleUseResponsesApiWebSearchToggle`, add:

```ts
const handleUseResponsesApiContextManagementToggle = useCallback(
  (value: boolean) => {
    setDraft((prev) => ({ ...prev, useResponsesApiContextManagement: value }))
  },
  [setDraft],
)
```

Near other derived booleans, add:

```ts
const useResponsesApiContextManagement =
  draft.useResponsesApiContextManagement ?? true
```

In the returned object, add:

```ts
useResponsesApiContextManagement,
onUseResponsesApiContextManagementToggle:
  handleUseResponsesApiContextManagementToggle,
```

- [ ] **Step 6: Render the new section**

Update `sections` in `SettingsPageView`:

```ts
const sections = useMemo<Array<SettingsSection>>(() => {
  return [
    { id: "general", label: t("settingsPage.sections.general") },
    { id: "reasoning", label: t("settingsPage.sections.reasoning") },
    { id: "responsesApi", label: t("settingsPage.sections.responsesApi") },
    { id: "aliases", label: t("settingsPage.sections.aliases") },
    { id: "prompts", label: t("settingsPage.sections.prompts") },
    { id: "advanced", label: t("settingsPage.sections.advanced") },
    { id: "providers", label: t("settingsPage.sections.providers") },
    { id: "devMode", label: t("settingsPage.sections.devMode") },
  ]
}, [t])
```

Replace the standalone `CompactThresholds` `SettingsSectionCard` block with a new `Responses API` section:

```tsx
{/* Responses API */}
<SettingsSectionCard
  id="responsesApi"
  isActive={activeSection === "responsesApi"}
  ref={(el) => registerSection("responsesApi", el)}
  style={{ animationDelay: "90ms" }}
>
  <ResponsesApiSettingsCard
    useResponsesApiWebSocket={useResponsesApiWebSocket}
    useResponsesApiWebSearch={useResponsesApiWebSearch}
    useResponsesApiContextManagement={useResponsesApiContextManagement}
    responsesApiContextManagementModelsValue={
      responsesApiContextManagementModelsValue
    }
    compactThresholdsMode={compactThresholdsMode}
    compactThresholdsJson={compactThresholdsJson}
    compactThresholdsJsonIssue={compactThresholdsJsonIssue}
    compactThresholdsItems={compactThresholdsItems}
    models={models}
    onToggleUseResponsesApiWebSocket={onUseResponsesApiWebSocketToggle}
    onToggleUseResponsesApiWebSearch={onUseResponsesApiWebSearchToggle}
    onToggleUseResponsesApiContextManagement={
      onUseResponsesApiContextManagementToggle
    }
    onResponsesApiContextManagementModelsChange={
      onResponsesApiContextManagementModelsChange
    }
    onCompactThresholdsToggleMode={onCompactThresholdsToggleMode}
    onCompactThresholdsJsonChange={onCompactThresholdsJsonChange}
    onCompactThresholdsAddItem={onCompactThresholdsAddItem}
    onCompactThresholdsRemoveItem={onCompactThresholdsRemoveItem}
    onCompactThresholdsUpdateItem={onCompactThresholdsUpdateItem}
  />
</SettingsSectionCard>
```

Update the `AdvancedSettingsCard` call to remove Responses API props and callbacks.

- [ ] **Step 7: Run admin-ui typecheck to reveal wiring mistakes**

Run:

```bash
bun run typecheck:admin
```

Expected before locale/test updates:

- Typecheck should pass or only report missing destructured props if a wiring step was missed.
- Fix any missing prop/destructure errors before continuing.

---

## Task 5: Add i18n copy for Responses API section

**Files:**
- Modify: `admin-ui/src/locales/en-US.json`
- Modify: `admin-ui/src/locales/zh-CN.json`

- [ ] **Step 1: Add section label in English**

In `admin-ui/src/locales/en-US.json`, under `settingsPage.sections`, change the section block from including `compactThresholds` to including `responsesApi`:

```json
"sections": {
  "general": "General",
  "reasoning": "Reasoning",
  "responsesApi": "Responses API",
  "aliases": "Aliases",
  "prompts": "Prompts",
  "advanced": "Advanced",
  "providers": "Providers",
  "devMode": "Dev Mode"
}
```

- [ ] **Step 2: Add English Responses API copy**

In the same `settingsPage` object, add a new sibling object before `advanced`:

```json
"responsesApi": {
  "title": "Responses API",
  "description": "Configure Responses API transport, web tools, and context management.",
  "transportGroupTitle": "Transport",
  "contextManagementGroupTitle": "Context management",
  "useResponsesApiWebSocketLabel": "Enable Responses API WebSocket",
  "useResponsesApiWebSocketHint": "When enabled, models advertising ws:/responses use Copilot's WebSocket transport; HTTP remains available for /responses-only models.",
  "useResponsesApiWebSearchLabel": "Enable Responses API WebSearch",
  "useResponsesApiWebSearchHint": "When enabled, /v1/responses keeps web_search tools and forwards them upstream.",
  "useResponsesApiContextManagementLabel": "Enable Responses API context management",
  "useResponsesApiContextManagementHint": "Default: enabled. When enabled, the proxy automatically adds context_management compaction instructions for long Responses API tasks.",
  "contextManagementInactiveTitle": "Context management is disabled",
  "contextManagementInactiveHint": "This legacy list is saved but does not take effect while context management is disabled.",
  "compactThresholdsInactiveHint": "Compact threshold overrides are saved but do not take effect while context management is disabled.",
  "responsesApiContextManagementModelsLabel": "Legacy context management models",
  "responsesApiContextManagementModelsPlaceholder": "one model id per line",
  "responsesApiContextManagementModelsDeprecatedHint": "Deprecated legacy allowlist. Prefer the global Responses API context management switch."
}
```

Keep existing `settingsPage.compactThresholds` copy because `CompactThresholdsCard` still uses it.

- [ ] **Step 3: Add section label in Chinese**

In `admin-ui/src/locales/zh-CN.json`, under `settingsPage.sections`, use:

```json
"sections": {
  "general": "通用",
  "reasoning": "推理强度",
  "responsesApi": "Responses API",
  "aliases": "别名",
  "prompts": "提示词",
  "advanced": "高级",
  "providers": "Providers",
  "devMode": "开发者模式"
}
```

- [ ] **Step 4: Add Chinese Responses API copy**

Add a new sibling object before `advanced`:

```json
"responsesApi": {
  "title": "Responses API",
  "description": "配置 Responses API transport、web 工具和上下文管理。",
  "transportGroupTitle": "Transport",
  "contextManagementGroupTitle": "上下文管理",
  "useResponsesApiWebSocketLabel": "启用 Responses API WebSocket",
  "useResponsesApiWebSocketHint": "启用后，声明 ws:/responses 的模型会使用 Copilot WebSocket transport；仅支持 /responses 的模型仍走 HTTP。",
  "useResponsesApiWebSearchLabel": "启用 Responses API WebSearch",
  "useResponsesApiWebSearchHint": "启用后，/v1/responses 会保留 web_search 工具并继续向上游转发。",
  "useResponsesApiContextManagementLabel": "启用 Responses API 上下文管理",
  "useResponsesApiContextManagementHint": "默认启用。启用后，代理会为长任务自动附加 context_management 压缩指令。",
  "contextManagementInactiveTitle": "上下文管理已关闭",
  "contextManagementInactiveHint": "该旧模型列表会被保存，但在上下文管理关闭时不会生效。",
  "compactThresholdsInactiveHint": "压缩阈值覆盖会被保存，但在上下文管理关闭时不会生效。",
  "responsesApiContextManagementModelsLabel": "旧版上下文管理模型",
  "responsesApiContextManagementModelsPlaceholder": "每行一个 model id",
  "responsesApiContextManagementModelsDeprecatedHint": "已弃用的旧 allowlist。推荐使用全局 Responses API 上下文管理开关。"
}
```

Keep existing `settingsPage.advanced.useResponsesApi*` keys until a later cleanup pass if they are no longer referenced. Removing unused locale keys is optional and not required for this implementation.

- [ ] **Step 5: Validate JSON and typecheck**

Run:

```bash
bun run typecheck:admin
```

Expected:

- PASS.
- If JSON syntax is invalid, TypeScript/Vite import will fail; fix commas and object placement.

---

## Task 6: Update settings page tests for the new Responses API card

**Files:**
- Modify: `admin-ui/tests/settings-page.test.tsx`

- [ ] **Step 1: Replace import**

Change:

```ts
import { AdvancedSettingsCard } from "../src/pages/settings-page"
```

to:

```ts
import { ResponsesApiSettingsCard } from "../src/pages/settings-page"
```

- [ ] **Step 2: Replace the existing test with Responses API card tests**

Replace the file body after imports with:

```ts
test("Responses API settings exposes transport toggles and context management", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement
      useResponsesApiWebSearch
      useResponsesApiWebSocket={false}
      responsesApiContextManagementModelsValue=""
      compactThresholdsMode="form"
      compactThresholdsJson="{}"
      compactThresholdsJsonIssue={null}
      compactThresholdsItems={[]}
      models={[]}
      onCompactThresholdsAddItem={() => {}}
      onCompactThresholdsJsonChange={() => {}}
      onCompactThresholdsRemoveItem={() => {}}
      onCompactThresholdsToggleMode={() => {}}
      onCompactThresholdsUpdateItem={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Enable Responses API WebSocket")
  expect(html).toContain("ws:/responses")
  expect(html).toContain("Enable Responses API context management")
  expect(html).toContain("Default: enabled")
  expect(html).toContain("Legacy context management models")
  expect(html).toContain('aria-checked="false"')
})

test("Responses API settings marks dependent fields inactive when context management is off", () => {
  const html = renderToStaticMarkup(
    <ResponsesApiSettingsCard
      useResponsesApiContextManagement={false}
      useResponsesApiWebSearch
      useResponsesApiWebSocket
      responsesApiContextManagementModelsValue="gpt-5.4"
      compactThresholdsMode="form"
      compactThresholdsJson="{}"
      compactThresholdsJsonIssue={null}
      compactThresholdsItems={[]}
      models={[]}
      onCompactThresholdsAddItem={() => {}}
      onCompactThresholdsJsonChange={() => {}}
      onCompactThresholdsRemoveItem={() => {}}
      onCompactThresholdsToggleMode={() => {}}
      onCompactThresholdsUpdateItem={() => {}}
      onResponsesApiContextManagementModelsChange={() => {}}
      onToggleUseResponsesApiContextManagement={() => {}}
      onToggleUseResponsesApiWebSearch={() => {}}
      onToggleUseResponsesApiWebSocket={() => {}}
    />,
  )

  expect(html).toContain("Context management is disabled")
  expect(html).toContain("Compact threshold overrides are saved")
  expect(html).toContain("gpt-5.4")
}
```

- [ ] **Step 3: Run the settings page test**

Run:

```bash
bun test admin-ui/tests/settings-page.test.tsx
```

Expected:

- PASS.

If the test fails because i18next returns keys instead of English text, ensure `admin-ui/tests/settings-page.test.tsx` is still loading the project i18n setup through component imports. If it still returns keys, assert against key strings such as `settingsPage.responsesApi.title`; do not mock i18n in this plan.

---

## Task 7: Full targeted verification and cleanup

**Files:**
- Inspect all modified files.
- No new source files required.

- [ ] **Step 1: Run backend targeted tests**

Run:

```bash
bun test tests/admin-config.test.ts tests/responses-handler.test.ts
```

Expected:

- PASS.

- [ ] **Step 2: Run frontend targeted test**

Run:

```bash
bun test admin-ui/tests/settings-page.test.tsx
```

Expected:

- PASS.

- [ ] **Step 3: Run typechecks**

Run:

```bash
bun run typecheck
bun run typecheck:admin
```

Expected:

- Both PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
bun run lint
bun run lint:admin
```

Expected:

- Both PASS or auto-fix-free lint success.
- If lint reports formatting issues, run the repository’s established lint/fix command only for the affected scope, then rerun lint.

- [ ] **Step 5: Inspect diff for scope control**

Run:

```bash
git diff -- src/routes/admin-api/route.ts tests/admin-config.test.ts tests/responses-handler.test.ts admin-ui/src/lib/admin-api.ts admin-ui/src/pages/settings-page.tsx admin-ui/src/locales/en-US.json admin-ui/src/locales/zh-CN.json admin-ui/tests/settings-page.test.tsx docs/superpowers/plans/2026-06-06-admin-ui-settings-page-optimization.md docs/superpowers/plans/2026-06-06-admin-ui-settings-page-optimization-implementation.md
```

Expected:

- Diff only touches planned files plus the two plan documents.
- No unrelated refactor.
- No deletion of deprecated config support.
- No git commit unless the user explicitly asks.

- [ ] **Step 6: Final report**

Report:

- Files changed.
- Tests and checks run with pass/fail status.
- Any skipped checks with reason.
- Whether `useResponsesApiContextManagement` is now configurable from Admin-UI.

Do not claim completion unless all selected verification commands pass.

---

## Self-Review

### Spec coverage

- `useResponsesApiContextManagement` Admin API support: Task 1.
- Runtime enabled/disabled behavior: Task 2.
- Frontend type and POST whitelist: Task 3.
- Responses API section and card: Task 4.
- Default/deprecated/inactive copy: Task 5.
- Frontend card rendering tests: Task 6.
- Verification and scope control: Task 7.

### Placeholder scan

This plan contains no unresolved placeholder markers. The only optional note is the explicit fallback for i18n test behavior, with a concrete alternative assertion.

### Type consistency

- Field name is consistently `useResponsesApiContextManagement`.
- Section id is consistently `responsesApi`.
- Component name is consistently `ResponsesApiSettingsCard`.
- Existing `modelResponsesApiCompactThresholds` remains represented by `CompactThresholdsCard` state props.
