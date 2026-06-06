# Admin-UI 设置页优化设计

## 背景

Admin-UI 设置页已经承载多类配置：基础鉴权、小模型、推理强度、Responses API compact threshold、模型别名、extra prompts、Providers、Dev Mode 和高级选项。近期新增的 `useResponsesApiContextManagement` 已在后端运行时配置中存在，并默认启用，但没有完整接入 Admin-UI 与 Admin API 写入链路；旧字段 `responsesApiContextManagementModels` 虽已标记为 deprecated，却仍然暴露在 Advanced 设置中。

本设计选择分阶段综合优化：先修复配置完整性，再重组 Responses API 领域配置，最后补齐安全可用性细节。目标是在不重写整个设置页的前提下，降低配置遗漏、误用和信息架构膨胀的风险。

## 目标

1. 让 `useResponsesApiContextManagement` 能在 Admin-UI 中查看、编辑并保存。
2. 将 Responses API 相关配置集中到独立 section，避免继续扩张 `AdvancedSettingsCard`。
3. 保留 deprecated 配置的兼容性，同时通过 UI 文案降低误用概率。
4. 明确默认值、生效状态和依赖关系，减少用户误判。
5. 用 targeted tests 覆盖前端、后端和运行时关键路径。

## 非目标

本轮不做以下事项：

- 不做全量 schema-driven 设置页。
- 不重写整个 `SettingsPage` 状态管理。
- 不引入新的表单库。
- 不自动迁移或删除 deprecated 配置。
- 不改变 runtime context management 的默认行为。
- 不新增全局“恢复所有默认值”功能。

## 方案选择

采用 **分阶段综合优化**。

备选方案包括：

- 快速补丁：只在 Advanced 中新增 `useResponsesApiContextManagement` 开关。优点是改动最小，缺点是 Advanced 继续膨胀，Responses API 字段仍分散。
- 深度重构：将设置页改成 schema-driven。优点是长期最稳，缺点是范围过大，会延后当前配置缺口修复。

推荐方案先解决当前缺口，再逐步改善信息架构，符合 KISS 和 YAGNI。

## 信息架构

### Phase 1：配置完整性

补齐 `useResponsesApiContextManagement` 的完整配置链路：

- 后端 Admin API 允许读取、写入、清除该字段。
- 前端 `AdminConfig` 类型包含该字段。
- 前端提交白名单包含该字段，避免 `updateAdminConfig()` 过滤。
- 设置页提供 Switch 控件。
- i18n 文案覆盖中英文。
- 测试覆盖保存、清除和无效输入。

`responsesApiContextManagementModels` 保留，但标记为 legacy/deprecated。

### Phase 2：Responses API 独立分组

新增 **Responses API** section，将下列字段集中展示：

- `useResponsesApiWebSocket`
- `useResponsesApiWebSearch`
- `useResponsesApiContextManagement`
- `modelResponsesApiCompactThresholds`
- `responsesApiContextManagementModels`（Legacy / deprecated）

`AdvancedSettingsCard` 保留跨领域和低频选项，例如：

- `accountAffinity`
- `allowOriginalModelNamesForAliases`
- `forceAgent`
- `compactUseSmallModel`
- `messageStartInputTokensFallback`
- `modelRefreshIntervalHours`
- `sessionAffinityRetentionDays`
- `useMessagesApi`

### Phase 3：安全可用性增强

补齐以下交互细节：

- 显示默认值与当前有效值，尤其是默认启用的布尔配置。
- 对 deprecated 字段使用折叠区域或 warning copy。
- 当 `useResponsesApiContextManagement === false` 时，compact thresholds 与 legacy model list 保留值但提示不生效。
- 对清空覆盖值使用现有语义，不自动删除用户已有旧配置。

## 组件设计

### `ResponsesApiSettingsCard`

新增组件，职责限定为 `/v1/responses` 相关配置。

建议分组：

1. Transport
   - `useResponsesApiWebSocket`
   - `useResponsesApiWebSearch`
2. Context Management
   - `useResponsesApiContextManagement`
   - `modelResponsesApiCompactThresholds`
3. Legacy / Deprecated
   - `responsesApiContextManagementModels`

该组件不负责加载/保存，只通过 props 接收状态和回调，保持与现有 card 模式一致。

### `AdvancedSettingsCard`

移除 Responses API 专属字段，保留跨领域高级配置。这样可以降低单个 card 的职责范围，并避免后续新增 Responses API 字段时继续堆入 Advanced。

### `useSettingsPageState`

短期保留现有集中状态管理模式，只新增必要状态派生和 handler。长期如果设置页继续增长，再考虑把 Responses API 状态和转换逻辑抽成专用 hook。

新增派生值：

```ts
const useResponsesApiContextManagement =
  draft.useResponsesApiContextManagement ?? true
```

新增切换 handler：

```ts
const handleUseResponsesApiContextManagementToggle = useCallback(
  (value: boolean) => {
    setDraft((prev) => ({ ...prev, useResponsesApiContextManagement: value }))
  },
  [setDraft],
)
```

## 数据流

完整链路如下：

```text
src/lib/config.ts
  ↓
src/routes/admin-api/route.ts
  ↓
admin-ui/src/lib/admin-api.ts
  ↓
admin-ui/src/pages/settings-page.tsx
  ↓
tests
```

### 后端 Admin API

在 `src/routes/admin-api/route.ts` 中补齐：

- `CONFIG_KEYS` 加入 `useResponsesApiContextManagement`。
- `CONFIG_PATCH_HANDLERS` 使用现有 `applyOptionalBoolean(next, "useResponsesApiContextManagement", value)` 模式。

语义：

- `true` / `false`：显式保存用户覆盖值。
- `null` / `undefined`：删除用户覆盖值，回到默认 `true`。
- 非 boolean：返回 400，错误信息包含字段名。

### 前端 Admin API

在 `admin-ui/src/lib/admin-api.ts` 中补齐：

- `AdminConfig.useResponsesApiContextManagement?: boolean`
- `ADMIN_CONFIG_KEYS` 加入 `useResponsesApiContextManagement`

这样 UI draft 中的字段不会在提交前被过滤。

### 设置页

新增 `ResponsesApiSettingsCard` 后，`SettingsPageView` 传入：

- `useResponsesApiWebSocket`
- `useResponsesApiWebSearch`
- `useResponsesApiContextManagement`
- `responsesApiContextManagementModelsValue`
- compact thresholds editor 相关 props
- 对应 toggle/change handlers

`AdvancedSettingsCard` 删除这些 Responses API 专属 props。

## 交互规则

### `useResponsesApiContextManagement`

- 使用 Switch。
- 默认值为 `true`。
- 文案说明开启后代理会自动附加 `context_management` 压缩指令。
- UI 显示默认行为，避免用户误解未配置为关闭。

### `modelResponsesApiCompactThresholds`

- 保留现有 key-value / JSON 双模式编辑器。
- 迁移到 Responses API section。
- 当 context management 关闭时：
  - 不删除已有值。
  - 可以禁用编辑器，或保持可编辑但显示“不生效”提示。
  - MVP 推荐保持可编辑并显示 warning，避免 disabled 状态阻止用户预先配置。

### `responsesApiContextManagementModels`

- 保留 textarea。
- 放入 Legacy / Deprecated 区域。
- 文案明确：该字段已弃用，推荐使用全局开关。
- 当 context management 关闭时，显示该配置当前不生效。

## 错误处理

### 前端

- 保存失败继续使用现有 `AdminApiError` 和 toast 机制。
- `responsesApiContextManagementModels` 保留现有解析：trim、去重、忽略空行。
- `modelResponsesApiCompactThresholds` 保留现有校验：model id 非空，threshold 为正有限数字。
- Context management 关闭不会触发校验错误，也不会清空已有配置。

### 后端

- 使用统一 boolean parser。
- 无效类型返回 400。
- 不自动迁移 deprecated 字段。
- 不改变默认运行时行为。

## 测试策略

### Admin API tests

覆盖：

- POST `{ useResponsesApiContextManagement: false }` 返回 false。
- POST `{ useResponsesApiContextManagement: true }` 返回 true。
- POST `{ useResponsesApiContextManagement: null }` 清除覆盖后返回默认 true。
- POST 非 boolean 返回 400。

### Settings page tests

覆盖：

- 渲染 Responses API section。
- Context management Switch 显示默认启用。
- 切换后页面变 dirty。
- 保存 payload 包含 `useResponsesApiContextManagement`。
- Deprecated legacy textarea 仍可编辑。

### Runtime behavior tests

覆盖：

- 默认或显式 true 时，Responses API payload 自动带 `context_management`。
- 显式 false 时，不自动附加 `context_management`。
- 请求本身已有 `context_management` 时不覆盖。

### 质量检查

按改动范围执行：

```bash
bun test tests/admin-config.test.ts tests/responses-handler.test.ts
bun run lint
bun run typecheck
```

如果前端测试覆盖设置页，则额外运行对应 Admin-UI 测试命令。

## 实施顺序

1. 后端 Admin API 支持 `useResponsesApiContextManagement`。
2. 前端 Admin API 类型与提交白名单补齐。
3. 设置页新增 `ResponsesApiSettingsCard` 并迁移 Responses API 字段。
4. 更新中英文 i18n 文案。
5. 补充 targeted tests。
6. 执行验证命令并修复问题。

## 风险与缓解

- 风险：前端显示字段但提交被过滤。
  - 缓解：同步更新 `AdminConfig` 和 `ADMIN_CONFIG_KEYS`，并用测试覆盖保存 payload。
- 风险：后端接受字段但运行时默认行为变化。
  - 缓解：保留 `config.useResponsesApiContextManagement ?? true` 语义，并加 runtime tests。
- 风险：迁移 UI 分组导致用户找不到旧配置。
  - 缓解：Responses API section 明确包含 Legacy / Deprecated 区域，不删除字段。
- 风险：设置页文件继续膨胀。
  - 缓解：新增职责明确的 `ResponsesApiSettingsCard`，后续再考虑 hook 拆分。

## 验收标准

1. Admin-UI 中能看到并切换 `useResponsesApiContextManagement`。
2. 保存后配置文件中的显式 true/false 能正确反映用户选择。
3. 清除覆盖值后回到默认启用。
4. Responses API 相关字段集中在独立 section。
5. Deprecated 字段有清晰提示且仍能编辑。
6. Targeted tests、lint 和 typecheck 按改动范围通过。
