# caozhiyuan → all 合并方案：Responses Tool Search 与 cache_control 修复

## 目标

将 `caozhiyuan` 分支自上次合并后新增的公共能力吸收到 `all` 分支，同时保留 `all` 的核心差异：多 GitHub Copilot 账号、Admin-UI、请求历史、亲和性路由、配额预留、Responses/WebSocket 传输与现有 Claude Code 子代理语义。

## 本轮应吸收的功能

1. **Responses API Tool Search / deferred tools 支持**
   - 新增 `src/lib/tool-search.ts`，负责识别 `tool_search`、桥接 MCP tool、alias、sentinel、deferred tools 选择与 GPT 5.4+ 条件。
   - 新增 `src/mcp.ts` 与 `mcp` CLI 子命令，提供 `search` MCP tool，返回 `copilot_api_tool_search` sentinel。
   - 更新 Responses 翻译层，将 Anthropic bridge/deferred tools 转换为 Responses `tool_search` 与 namespace/function tools。
   - 更新 Responses stream 翻译层，支持 `tool_search_call`、`tool_search_output` 和 bridge tool name。
   - 新增/更新 Tool Search 相关测试。

2. **最后一条消息内容块 `cache_control` 保留修复**
   - 在 `stripToolReferenceTurnBoundary()` 与 `mergeToolResultForClaude()` 的预处理管线中，保留最后一条 user message 内容块上的 `cache_control`。
   - 同时继续去除 Copilot 不支持的 `cache_control.scope`，只保留可转发的 `type`。

3. **版本与文档同步**
   - 版本提升到 `1.10.7`。
   - 保留 README 中与 Tool Search/MCP 相关的公共说明。
   - 保持包名、仓库链接和发布归属为 `nick3/copilot-api`。

## 本轮不应吸收的内容

1. **Electron UI 路线**
   - 不恢复 `desktop/` 或 Electron 入口。
   - 不删除或替换 Admin-UI。

2. **单账号架构回退**
   - 不接受会绕开或移除 `accountsManager`、`AccountContext`、配额预留、亲和性路由、请求历史的实现。
   - 不把 `/v1/messages` 恢复为上游单账号 flow。

3. **上游生成版 `CLAUDE.md`**
   - 根 `CLAUDE.md` 保持 `@AGENTS.md`。
   - 项目规范继续以 `AGENTS.md` 为 source of truth。

4. **上游包身份信息**
   - 不接受 `@jeffreycao/copilot-api`、`caozhiyuan/copilot-api` 的 package metadata。

## 冲突文件处理策略

### `CLAUDE.md`

采用 `all` 版本：

```md
@AGENTS.md
```

理由：本仓库已有面向 agent 的 `AGENTS.md`，根 `CLAUDE.md` 只做索引，避免引入与当前项目事实冲突的上游生成说明。

### `package.json`

合并规则：

```json
"name": "@nick3/copilot-api",
"version": "1.10.7"
```

同时保留：

- `homepage`、`bugs`、`repository` 指向 `nick3/copilot-api`。
- Admin-UI 相关 scripts 与 files。
- 新增依赖 `@modelcontextprotocol/sdk`。
- 现有 build/test/lint/typecheck 脚本。

### `bun.lock` 与 `package-lock.json`

以最终 `package.json` 为准重新生成 lockfile，确保：

- root package name 为 `@nick3/copilot-api`。
- root package version 为 `1.10.7`。
- `@modelcontextprotocol/sdk` 进入锁文件。
- 不引入与 Electron UI 相关的依赖。

建议执行顺序：

```bash
bun install --lockfile-only
npm install --package-lock-only --ignore-scripts
```

随后检查 lockfile diff，确认只有 root metadata、MCP SDK 依赖树和必要 lock metadata 变化。

### `src/routes/messages/anthropic-types.ts`

采用上游新增的更完整 `AnthropicCacheControl` 类型，同时保持 `all` 现有 Anthropic payload 类型结构。

期望类型形态：

```ts
export interface AnthropicCacheControl {
  type: string
  scope?: string | null
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: AnthropicCacheControl | null
}
```

理由：上游修复依赖 `scope` 可被识别并剥离，`all` 需要继续允许 `null` 与现有 payload 兼容。

### `src/routes/messages/preprocess.ts`

合并两边能力：

1. 保留 `all` 的 `stripTextBlockCacheControl()` 递归处理逻辑。
2. 接入上游新增的：
   - `getLastMessageContentCacheControl()`
   - `applyLastMessageCacheControl()`
3. `stripTextBlockCacheControl()` 的输出只保留 `{ type }`，丢弃 `scope`。
4. `mergeToolResultForClaude()` 之后调用 `applyLastMessageCacheControl()`，恢复最后一条消息内容块上的 cache marker。

预期关键行为：

- system blocks 的 `cache_control.scope` 被移除。
- normal message text blocks 的 `cache_control.scope` 被移除。
- nested `tool_result.content[].cache_control.scope` 被移除。
- 最后一条 user message block 的 `{ cache_control: { type: "ephemeral" } }` 经过 merge pipeline 后仍存在。

### `src/routes/messages/handler.ts`

保留 `all` 的 handler 架构，吸收上游 cache_control 修复。

处理步骤：

1. 删除冲突中重复的上游 import block。
2. 从 `./preprocess` 导入：

```ts
applyLastMessageCacheControl,
getLastMessageContentCacheControl,
mergeToolResultForClaude,
stripToolReferenceTurnBoundary,
```

3. 在修改 `anthropicPayload.messages` 之前捕获最后一条消息 cache marker：

```ts
const lastMessageCacheControl = getLastMessageContentCacheControl(
  anthropicPayload.messages.at(-1),
)
```

4. 保持 `all` 的 compact/smallModel 分支：

```ts
if (compactType === COMPACT_REQUEST && shouldCompactUseSmallModel()) {
  anthropicPayload.model = getSmallModel()
}
```

5. 保持 `all` 的非 compact 才执行 tool-result merge：

```ts
if (compactType === 0) {
  stripToolReferenceTurnBoundary(anthropicPayload)
  mergeToolResultForClaude(anthropicPayload, targetEndpoint)
}
```

6. merge 后恢复最后一条消息 cache marker：

```ts
applyLastMessageCacheControl(anthropicPayload, lastMessageCacheControl)
```

7. 保留 `all` 的：
   - `requestId` / `upstreamRequestId` 语义。
   - `accountsManager.selectAccountForRequest()`。
   - quota reservation。
   - affinity key/session/root session 逻辑。
   - `useMessagesApi` / Responses / chat completions route selection。
   - request history 与 usage 记录。

不要引入上游单账号 flow 中的第二套 `requestId` 或 state-only account access。

### `src/routes/messages/api-flows.ts`

合并 Tool Search stream state，同时保留 `all` 的 usage 类型。

1. 新增 import：

```ts
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
```

2. 修改 Responses streaming 初始化：

```ts
const streamState = createResponsesStreamState({
  toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
})
let usage: NormalizedUsage = {}
```

3. 保留 `all` 的 multi-account、instrumentation、history usage 逻辑。

### `src/routes/messages/responses-stream-translation.ts`

在 `ResponsesStreamState` 中同时保留两边字段：

```ts
functionCallStateByOutputIndex: Map<number, ResponsesStreamFunctionCallState>
responseStatus?: string
estimatedInputTokens?: number
historicalInputTokens?: number
historicalOutputTokens?: number
historicalCachedInputTokens?: number
toolSearchName: string
```

`createResponsesStreamState()` 初始化时：

- 默认 `toolSearchName` 使用 `BRIDGE_TOOL_SEARCH_NAME`。
- 保留 `all` 的历史 token/usage 估算字段。

### `src/routes/messages/responses-translation.ts`

当前文件已自动合并，但需要复核以下点：

- 保留 Tool Search 转换逻辑。
- 保留 `all` 已有 input_file/document、reasoning、compaction、usage 翻译逻辑。
- `tool_search_output` 到 Anthropic tool result 的映射不破坏既有 function tool 映射。

### `src/services/copilot/create-responses.ts`

当前文件已自动合并，但需要复核以下点：

- 保留 `AccountContext` 参数与 account-scoped headers。
- 保留 WebSocket transport、quota snapshot、initiator headers、request-context capture。
- 接受 Tool Search 相关 payload/output 类型新增。
- 不回退到全局 `state` 单账号 token。

### `tests/messages-handler.test.ts`

合并测试而非二选一：

- 保留 `all` 的 routing、多账号、quota、affinity、warmup、compact、Responses transport 测试。
- 追加上游新增的 cache_control 测试，验证最后一条 message block 的 cache marker 在 merge 后保留。

### `tests/responses-translation.test.ts`

合并测试而非二选一：

- 保留 `all` 的 document/input_file、reasoning、Responses translation 测试。
- 追加上游 Tool Search 测试，覆盖：
  - bridge/deferred tools → Responses `tool_search` 与 namespace。
  - `tool_search_call` / `tool_search_output` 回译。
  - tool search bridge alias。

## 执行顺序

1. **解决 metadata 与文档冲突**
   - `CLAUDE.md` 保持 `@AGENTS.md`。
   - `package.json` 保持 `@nick3/copilot-api`，版本设为 `1.10.7`，保留 MCP SDK dependency。
   - README 只保留公共 Tool Search/MCP 说明，不引入 Electron-only 指令。

2. **解决核心类型与预处理冲突**
   - 合并 `AnthropicCacheControl` 类型。
   - 合并 `preprocess.ts` 的 cache_control strip + capture/apply helpers。

3. **解决 `/v1/messages` flow 冲突**
   - `handler.ts` 保留 `all` handler 主体，只插入 cache_control capture/apply。
   - `api-flows.ts` 插入 `resolveBridgeToolSearchName()`，保留 `NormalizedUsage`。
   - `responses-stream-translation.ts` 合并 usage fields 与 `toolSearchName`。

4. **解决测试冲突**
   - 测试文件全部采用“保留 all 测试 + 追加上游测试”的策略。
   - 不删除现有多账号/Admin-UI/Responses/WebSocket 覆盖。

5. **同步 lockfile**
   - 从最终 `package.json` 重新生成 `bun.lock` 与 `package-lock.json`。
   - 检查 lockfile 中 root package identity 与 MCP SDK 依赖。

6. **验证**
   - 检查无冲突标记：

```bash
git diff --name-only --diff-filter=U
```

期望输出为空。

   - 检查冲突标记残留：

```bash
git diff --check
```

期望无 conflict marker 或 whitespace error。

   - 运行目标测试：

```bash
bun test tests/tool-search.test.ts tests/responses-translation.test.ts tests/responses-stream-translation.test.ts tests/messages-preprocess.test.ts tests/messages-handler.test.ts tests/messages-api-flows.test.ts
```

期望全部通过。

   - 运行类型与 lint：

```bash
bun run typecheck
bun run lint
```

期望全部通过。

   - 最后运行全量测试：

```bash
bun test
```

期望全部通过。

## 风险控制

- 不执行 `git reset --hard`、`git checkout --ours .`、`git checkout --theirs .`、`git clean`。
- 不删除当前未跟踪的 `AGENTS.md`、`docs/superpowers/plans/` 或其他用户文件。
- 不自动提交；冲突解决完成后由用户决定是否提交。
- 每个冲突文件都以“吸收公共功能、保留 all 架构”为判定标准。

## 成功标准

- Tool Search/MCP 能力可用。
- 最后一条 message content 的 `cache_control` 在 merge pipeline 后保留。
- 多账号、Admin-UI、request history、quota reservation、affinity routing 未被回退。
- `package.json` 保持 `nick3` 包身份并升级到 `1.10.7`。
- 所有冲突解除，目标测试、typecheck、lint 与全量测试通过。
