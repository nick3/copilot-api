# 上游 Copilot API 接口面 — 运行时参考

## 范围

本文档描述了本仓库中实现的**当前出站 GitHub Copilot API 接口面**。
它聚焦于本代码库实际发送到上游 Copilot 的请求，包括：

- base URL 解析
- 上游路径 + 方法
- 关键 headers
- 请求体字段
- 响应体 / 流事件形状
- 客户端路由到上游的映射
- 参与翻译或预处理的关键源文件

这是一份**运行时参考**，而非设计提案。

---

## Base URL 解析

所有上游 Copilot 请求通过 `src/lib/api-config.ts` 中的 `copilotBaseUrl(account)` 解析其 base URL。

解析顺序：

1. 当 `getEnterpriseDomain()` 已配置时，使用 `https://copilot-api.{enterpriseDomain}`
2. opencode OAuth app 模式下使用 `https://api.githubcopilot.com`
3. 当所选 account 上存在 `account.copilotApiUrl` 时使用该值
4. 按 account 类型的默认值：
   - `individual` → `https://api.githubcopilot.com`
   - `business` → `https://api.business.githubcopilot.com`
   - `enterprise` → `https://api.enterprise.githubcopilot.com`

主要源文件：
- `src/lib/api-config.ts`

---

## 实际上游 Copilot 端点

| 上游路径 | Method | 主要实现 |
|---|---|---|
| `/chat/completions` | `POST` | `src/services/copilot/create-chat-completions.ts` |
| `/v1/messages` | `POST` | `src/services/copilot/create-messages.ts` |
| `/responses` | `POST` | `src/services/copilot/create-responses.ts` |
| `/embeddings` | `POST` | `src/services/copilot/create-embeddings.ts` |
| `/models` | `GET` | `src/services/copilot/get-models.ts` |

---

## 客户端面向路由 → 上游映射

用户-facing 的路由并不总是与上游端点相同。

| 本地路由 / 入口 | 上游行为 |
|---|---|
| `POST /v1/messages` | 在 `/v1/messages`、`/responses` 和 `/chat/completions` 之间动态选择 |
| `POST /chat/completions` 和 `POST /v1/chat/completions` | 直接调用上游 `/chat/completions` |
| `POST /responses` 和 `POST /v1/responses` | 在本地预处理请求体，然后调用上游 `/responses` |
| `POST /embeddings` 和 `POST /v1/embeddings` | 直接调用上游 `/embeddings` |
| `GET /models` 和 `GET /v1/models` | **不**直接按请求代理；上游模型数据由 `getModels()` 在 account/model 刷新阶段拉取，而客户端路由本地返回的是 `getAvailableModels()` 结果在过滤 `blockedTargets` 后再叠加 alias |
| `/api/admin/*` | 无上游 Copilot 调用 |
| provider-forwarding 路由 | 不属于 Copilot 上游接口面 |

### `/v1/messages` 动态选择

`src/routes/messages/handler.ts` 按以下顺序构建候选列表：

1. `/v1/messages`（仅在启用 `useMessagesApi` 时）
2. `/responses`
3. `/chat/completions`

所选上游端点取决于模型可用性和 account 选择。

主要源文件：
- `src/routes/messages/handler.ts`
- `src/services/copilot/create-chat-completions.ts`
- `src/services/copilot/create-messages.ts`
- `src/services/copilot/create-responses.ts`

---

## 共享 Header 构造

大多数出站调用依赖 `src/lib/api-config.ts` 中的 `copilotHeaders()`。

### 标准 GitHub Copilot headers

在标准 GitHub Copilot 模式下，基础 header 集包括：

- `Authorization: Bearer {copilotToken}`
- `content-type: application/json`
- `copilot-integration-id: vscode-chat`
- `editor-version: vscode/{vsCodeVersion}`
- `editor-device-id`
- `editor-plugin-version`
- `user-agent`
- `openai-intent: conversation-agent`
- `x-github-api-version`
- `x-request-id`
- `x-vscode-user-agent-library-version`
- `x-agent-task-id`
- `x-interaction-type: conversation-agent`
- 可选 `copilot-vision-request: true`
- 可选 `vscode-machineid`
- 可选 `vscode-sessionid`

### Opencode OAuth 模式 headers

当运行时处于 opencode OAuth app 模式时，`copilotHeaders()` 构建面向 opencode 的 header 集：

- `Authorization: Bearer {copilotToken or githubToken}`
- `Accept: application/json`
- `Content-Type: application/json`
- 来自 `getOpencodeLLMHeaders()` 的 `OPENCODE_LLM_USER_AGENT` 默认 `User-Agent`
- `Openai-Intent: conversation-edits`
- 可选 `User-Agent` 覆盖：当入站请求已携带 `opencode/...` user agent 时，转发前会先进行规范化
- 可选 `x-session-affinity`
- 可选 `x-parent-session-id`
- 可选 `Copilot-Vision-Request: true`

### 每请求运行时 headers

调用方可能追加额外的 headers：

- `x-initiator: user | agent`
- 通过 `prepareInteractionHeaders()` 添加 interaction/session headers
- 通过 `prepareForCompact()` 添加 compact-mode headers
- 通过 `prepareMessageProxyHeaders()` 添加 messages-proxy headers
- 针对上游 `/v1/messages` 的 `anthropic-beta`

### `/models` header 变体

`GET /models` 使用 `copilotModelsHeaders()` 而非 `copilotHeaders()`。
与标准 Copilot header 集相比，它将 intent 重写为模型访问：

- `x-interaction-type: model-access`
- `openai-intent: model-access`
- 如果存在则移除 `x-interaction-id`
- 移除 `content-type`

### 标准模式下所有上游请求共享的 header 交集

如果按“标准 GitHub Copilot 模式下，所有上游 Copilot 请求都会携带的 header 字段名交集”来算，公共字段是：

- `Authorization`
- `copilot-integration-id`
- `editor-version`
- `editor-device-id`
- `editor-plugin-version`
- `user-agent`
- `openai-intent`
- `x-github-api-version`
- `x-request-id`
- `x-vscode-user-agent-library-version`
- `x-agent-task-id`
- `x-interaction-type`

这些字段都来自基础的 `githubCopilotHeaders()`；`/models` 也是先从这套 headers 派生，再做少量改写。

需要注意，以下是“字段名交集”，不等于所有值也完全相同：

- `openai-intent` / `x-interaction-type` 在大多数请求里是 `conversation-agent`，在 `/models` 里会改成 `model-access`，在特定 `messages-proxy` 场景里会改成 `messages-proxy`
- `x-request-id` 与 `x-agent-task-id` 在当前实现里通常使用同一个本地生成或本地派生的值

以下字段**不**属于所有上游请求都共享的交集：

- `content-type`：`/models` 会移除
- `x-initiator`：只在 `chat/completions`、`/v1/messages`、`/responses` 路径额外添加
- `x-interaction-id`：不是基础 header，且 `/models` 会显式移除
- `anthropic-beta`：仅用于上游 `/v1/messages`
- `copilot-vision-request`：仅 vision 请求携带
- `vscode-machineid` / `vscode-sessionid`：仅在对应值存在时才附带

主要源文件：
- `src/lib/api-config.ts`
- `src/services/copilot/create-chat-completions.ts`
- `src/services/copilot/create-messages.ts`
- `src/services/copilot/create-responses.ts`
- `src/services/copilot/create-embeddings.ts`
- `src/services/copilot/get-models.ts`

---

## 端点详情

## 1. `POST /chat/completions`

### 主要源文件

- 上游客户端：`src/services/copilot/create-chat-completions.ts`
- Anthropic → OpenAI 翻译：`src/routes/messages/non-stream-translation.ts`
- `/v1/messages` 端点选择：`src/routes/messages/handler.ts`
- 直接本地路由处理器：`src/routes/chat-completions/handler.ts`

### 使用场景

- 直接本地 `POST /chat/completions` 和 `POST /v1/chat/completions`
- 本地 `POST /v1/messages` 的回退目标

### 请求 headers

`createChatCompletions()` 发送：

- `copilotHeaders(...)`
- `x-initiator`
- interaction/session headers
- 启用时的 compact-mode 调整

### 请求体形状

上游负载类型为 `ChatCompletionsPayload`。

客户端类型当前支持的顶层字段：

- `messages: Message[]`
- `model: string`
- `temperature?: number | null`
- `top_p?: number | null`
- `max_tokens?: number | null`
- `stop?: string | string[] | null`
- `n?: number | null`
- `stream?: boolean | null`
- `frequency_penalty?: number | null`
- `presence_penalty?: number | null`
- `logit_bias?: Record<string, number> | null`
- `logprobs?: boolean | null`
- `response_format?: { type: "json_object" } | null`
- `seed?: number | null`
- `tools?: Tool[] | null`
- `tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } } | null`
- `user?: string | null`
- `reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null`
- `thinking_budget?: number`

`Message` 字段：

- `role: "user" | "assistant" | "system" | "tool" | "developer"`
- `content: string | ContentPart[] | null`
- `name?: string`
- `tool_calls?: ToolCall[]`
- `tool_call_id?: string`
- `reasoning_text?: string | null`
- `reasoning_opaque?: string | null`

`ContentPart` 当前为：

- `TextPart`: `{ type: "text", text: string }`
- `ImagePart`: `{ type: "image_url", image_url: { url: string, detail?: "low" | "high" | "auto" } }`

`Tool` 形状：

- `type: "function"`
- `function.name`
- `function.description?`
- `function.parameters`

### 从本地 `/v1/messages` 调用时的翻译说明

当 Anthropic 格式的输入被路由到上游 `/chat/completions` 时，`translateToOpenAI()` 先推导出 OpenAI 风格的负载，然后处理器在发送前将 `model` 重写为所选上游模型：

- `model` ← 初始从 `payload.model` 推导，然后在端点/account 选择后重写为 `selectedModel.id`
- `messages` ← 翻译后的 Anthropic system/user/assistant/tool_result/tool_use 内容
- `max_tokens` ← `payload.max_tokens`
- `stop` ← `payload.stop_sequences`
- `stream` ← `payload.stream`
- `temperature` ← `payload.temperature`
- `top_p` ← `payload.top_p`
- `user` ← `payload.metadata?.user_id`
- `tools` ← 翻译后的 Anthropic tools
- `tool_choice` ← 翻译后的 Anthropic tool choice
- `thinking_budget` ← 从 Anthropic `thinking` + 模型能力推导

额外运行时行为：

- 直接本地 `/chat/completions` 和 `/v1/chat/completions` 请求在调用方未提供时，从 `selectedModel.capabilities.limits.max_output_tokens` 填充 `max_tokens`
- `gpt-5-mini*` 请求在未提供时会获得默认的 `reasoning_effort`
- assistant 的 `thinking` blocks 可能被转换为 `reasoning_text` / `reasoning_opaque`
- Anthropic tool use 变为 OpenAI `tool_calls`
- Anthropic tool_result 变为 `role: "tool"` messages

### 非流式响应形状

`ChatCompletionResponse` 字段：

- `id`
- `object: "chat.completion"`
- `created`
- `model`
- `choices[]`
- 可选 `system_fingerprint`
- 可选 `usage`

每个非流式 `choice` 包括：

- `index`
- `message.role = "assistant"`
- `message.content`
- 可选 `message.reasoning_text`
- 可选 `message.reasoning_opaque`
- 可选 `message.tool_calls`
- `logprobs`
- `finish_reason`

### 流事件形状

流式传输使用 OpenAI 风格的 `ChatCompletionChunk` 事件。
重要字段：

- `id`
- `object: "chat.completion.chunk"`
- `created`
- `model`
- `choices[]`
- 可选 `usage`

每个 chunk choice 包含：

- `index`
- `delta.content?`
- `delta.role?`
- `delta.tool_calls?`
- `delta.reasoning_text?`
- `delta.reasoning_opaque?`
- `finish_reason`
- `logprobs`

---

## 2. `POST /v1/messages`

### 主要源文件

- 上游客户端：`src/services/copilot/create-messages.ts`
- Anthropic 负载类型：`src/routes/messages/anthropic-types.ts`
- 上游负载预处理：`src/routes/messages/preprocess.ts`
- 本地路由选择：`src/routes/messages/handler.ts`

### 使用场景

- 仅在启用 messages API 路由且所选 account 支持时，用于本地 `POST /v1/messages`

### 请求 headers

`createMessages()` 发送：

- `copilotHeaders(...)`
- `x-initiator`
- interaction/session headers
- 启用时的 compact-mode 调整
- 可选 messages-proxy headers
- 可选 `anthropic-beta`

#### 可选 messages-proxy headers

`messages-proxy` 只会出现在**实际上游目标是 `/v1/messages`** 的这条链路里；如果本地 `/v1/messages` 最终被路由到 `/responses` 或 `/chat/completions`，这里不会生效。

在标准 GitHub Copilot 模式下，当 `shouldUseMessageProxyHeaders(payload)` 返回 `true` 时，`prepareMessageProxyHeaders()` 会重写/添加：

- `x-agent-task-id`
- `x-request-id`
- `x-interaction-type: messages-proxy`
- `openai-intent: messages-proxy`
- `user-agent: vscode_claude_code/2.1.81 (external, sdk-ts, agent-sdk/0.2.81)`

命中条件不是简单的“有 `metadata.user_id`”，而是 `parseUserIdMetadata(metadata.user_id)` 必须**同时**解析出：

- `safetyIdentifier`
- `sessionId`

`parseUserIdMetadata()` 支持两类来源：

- legacy `user_id` 形状：从 `user_..._account` 提取 `safetyIdentifier`，并从 `_session_...` 提取 `sessionId`
- JSON `user_id` 形状：从 `device_id` 或 `account_uuid` 提取 `safetyIdentifier`，并从 `session_id` 提取 `sessionId`

命中后，`x-request-id` 与 `x-agent-task-id` 不会保留此前基础 headers 中的本地值，而是会在本地重新生成同一个 UUID 后覆盖写入。

在 opencode OAuth 模式下，`prepareMessageProxyHeaders()` 会提前返回，因此即使 `metadata.user_id` 包含两个值，这些 proxy headers 也不会被应用。

#### 可选 Anthropic beta header

`anthropic-beta` 会被过滤到白名单，可能包括：

- `interleaved-thinking-2025-05-14`
- `context-management-2025-06-27`
- `advanced-tool-use-2025-11-20`

当前行为详情：

- 如果 `thinking.type === "adaptive"`，则从出站 beta 列表中移除 `interleaved-thinking-2025-05-14`
- 如果调用方**未**发送任何 `anthropic-beta` header，且存在 `thinking.budget_tokens` 同时 thinking 不是 adaptive 的，则自动注入 `interleaved-thinking-2025-05-14`

### 请求体形状

上游负载类型为 `AnthropicMessagesPayload`。

顶层字段：

- `model: string`
- `messages: AnthropicMessage[]`
- `max_tokens: number`
- `system?: string | AnthropicTextBlock[]`
- `metadata?: { user_id?: string }`
- `stop_sequences?: string[]`
- `stream?: boolean`
- `temperature?: number`
- `top_p?: number`
- `top_k?: number`
- `tools?: AnthropicTool[]`
- `tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string }`
- `thinking?: { type: "enabled" | "adaptive"; budget_tokens?: number }`
- `service_tier?: "auto" | "standard_only"`
- `output_config?: { effort?: "low" | "medium" | "high" | "max" }`

消息/内容块：

- user message：`role: "user"`，`content: string | (text | image | tool_result)[]`
- assistant message：`role: "assistant"`，`content: string | (text | tool_use | thinking)[]`
- text block：`{ type: "text", text }`
- image block：`{ type: "image", source: { type: "base64", media_type, data } }`
- tool_result block：`{ type: "tool_result", tool_use_id, content, is_error? }`
- tool_reference block（在 `tool_result.content` 内有效）：`{ type: "tool_reference", tool_name }`
- tool_use block：`{ type: "tool_use", id, name, input }`
- thinking block：`{ type: "thinking", thinking, signature }`
- tool definition：`{ name, description?, input_schema }`

### 端点选择前的预处理变更

在端点选择及任何端点特定翻译之前，`src/routes/messages/handler.ts` 可能会重写传入的 Anthropic 负载：

- 当存在 `anthropic-beta` 且请求匹配 Claude Code warmup probe 形状时，`payload.model` 被强制设为 `getSmallModel()`
- 当检测到请求为 compact 且启用了 compact-small-model 路由时，`payload.model` 被强制设为 `getSmallModel()`
- 对于非 compact 请求，`stripToolReferenceTurnBoundary()` 会移除 `tool_reference` turns 周围独立的 `"Tool loaded."` 文本边界
- 对于非 compact 请求，`mergeToolResultForClaude()` 可能会将相邻的 text blocks 折叠到 `tool_result.content` 中

这些重写操作作用于工作中的 Anthropic 负载，因此实际上游模型和消息内容可能在 `prepareMessagesApiPayload()` 运行之前就已与原始客户端负载不同。

### 发送前的预处理

`prepareMessagesApiPayload()` 在上游 `/v1/messages` 调用之前变更负载：

- 将 text-block `cache_control` 规范化为受支持的 `{ type }` 形状，并移除非格式/不受支持的值
- 过滤不应转发的 assistant thinking blocks
- 当所选模型支持 adaptive thinking 且未强制使用 tool use 时：
  - 设置 `thinking = { type: "adaptive" }`
  - 从模型配置设置 `output_config.effort`

### 非流式响应形状

上游非流式结果类型：`AnthropicResponse`

字段：

- `id`
- `type: "message"`
- `role: "assistant"`
- `content: AnthropicAssistantContentBlock[]`
- `model`
- `stop_reason`
- `stop_sequence`
- `usage.input_tokens`
- `usage.output_tokens`
- 可选 `usage.cache_creation_input_tokens`
- 可选 `usage.cache_read_input_tokens`
- 可选 `usage.service_tier`

### 流事件形状

Anthropic 风格的 SSE 事件（`AnthropicStreamEventData`）：

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`
- `ping`
- `error`

重要的嵌套 delta 变体：

- text delta
- tool input 的 input JSON delta
- thinking delta
- signature delta

---

## 3. `POST /responses`

### 主要源文件

- 上游客户端：`src/services/copilot/create-responses.ts`
- Anthropic → Responses 翻译：`src/routes/messages/responses-translation.ts`
- 本地路由处理器：`src/routes/responses/handler.ts`
- 本地 `/v1/messages` 路由：`src/routes/messages/handler.ts`

### 使用场景

- 直接本地 `POST /responses` 和 `POST /v1/responses`
- 本地 `POST /v1/messages` 的首选/回退目标

### 请求 headers

`createResponses()` 发送：

- `copilotHeaders(...)`
- `x-initiator`
- interaction/session headers
- 启用时的 compact-mode 调整

### 发送前直接路由的预处理

直接本地 Responses 路由在上游调用之前变更负载：

1. 当功能标志禁用时，有条件地移除 web-search tools
2. 使用 `compactInputByLatestCompaction(payload)` 压缩输入
3. 将所选模型重写到一个克隆的上游负载上
4. 应用 `useFunctionApplyPatch(upstreamPayload)`
5. 应用 `applyResponsesApiContextManagement(...)`
6. 再次压缩上游负载

对于本地 `/v1/messages` → 上游 `/responses` 路径，翻译后的 Responses 负载在调用 `createResponses()` 之前也会经过 `applyResponsesApiContextManagement(...)` 和 `compactInputByLatestCompaction(...)`。

### 请求体形状

上游负载类型为 `ResponsesPayload`。

客户端当前建模的顶层字段：

- `model: string`
- `instructions?: string | null`
- `input?: string | ResponseInputItem[]`
- `tools?: Tool[] | null` 其中 `Tool = FunctionTool | Record<string, unknown>`
- `tool_choice?: "none" | "auto" | "required" | { name: string; type: "function" }`
- `temperature?: number | null`
- `top_p?: number | null`
- `max_output_tokens?: number | null`
- `metadata?: Record<string, string> | null`
- `stream?: boolean | null`
- `safety_identifier?: string | null`
- `prompt_cache_key?: string | null`
- `parallel_tool_calls?: boolean | null`
- `store?: boolean | null`
- `reasoning?: { effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null; summary?: "auto" | "concise" | "detailed" | null } | null`
- `context_management?: ResponseContextManagementItem[] | null`
- `include?: ResponseIncludable[]`
- `service_tier?: string | null`
- 类型定义允许任意额外的键

重要的 input item 变体：

- message item
  - `type?: "message"`
  - `role: "user" | "assistant" | "system" | "developer"`
  - `content?: string | ResponseInputContent[]`
  - `status?`
  - `phase?: "commentary" | "final_answer"`
- function call item
  - `type: "function_call"`
  - `call_id`
  - `name`
  - `arguments`
  - `status?`
- function call output item
  - `type: "function_call_output"`
  - `call_id`
  - `output: string | ResponseInputContent[]`
  - `status?`
- reasoning item
  - `id?`
  - `type: "reasoning"`
  - `summary[]`
  - `encrypted_content`
- compaction item
  - `type: "compaction"`
  - `id`
  - `encrypted_content`

重要的 input content 变体：

- text：`{ type: "input_text" | "output_text", text }`
- image：`{ type: "input_image", image_url?, file_id?, detail }`

### 从本地 `/v1/messages` 调用时的翻译说明

`translateAnthropicMessagesToResponsesPayload()` 当前生成具有以下默认值和推导字段的 Responses 负载：

- `model` ← 请求/所选模型
- `input` ← 翻译后的消息/tool/thinking 结构
- `instructions` ← 翻译后的系统提示；当存在 `system` 时，`translateSystemPrompt()` 还会追加 `getExtraPromptForModel(model)` 返回的模型特定额外提示
- `temperature = 1`
- `top_p` ← Anthropic `top_p ?? null`
- `max_output_tokens = max(payload.max_tokens, 12800)`
- `tools` ← 转换后的 Anthropic tools
- `tool_choice` ← 转换后的 Anthropic tool choice
- `metadata` ← Anthropic 元数据的浅拷贝
- `prompt_cache_key` ← 从 `metadata.user_id` 解析出的 `sessionId`
- `stream` ← Anthropic `stream ?? null`
- `store = false`
- `parallel_tool_calls = true`
- `reasoning = { effort, summary: "auto" }`
- `include = ["reasoning.encrypted_content"]`

当前细节：

- `ResponsesPayload` 支持 `safety_identifier`，但当前 Anthropic 翻译路径**不会**填充它
- `createResponses()` 在发送前强制设置 `service_tier = null`，因为 GitHub Copilot 不支持它

### 非流式响应形状

`ResponsesResult` 字段：

- `id`
- `object: "response"`
- `created_at`
- `model`
- `output: ResponseOutputItem[]`
- `output_text`
- `status`
- `usage?`
  - `input_tokens`
  - `output_tokens?`
  - `total_tokens`
  - `input_tokens_details?.cached_tokens`
  - `output_tokens_details?.reasoning_tokens`
- `error`
- `incomplete_details`
- `instructions`
- `metadata`
- `parallel_tool_calls`
- `temperature`
- `tool_choice`
- `tools`
- `top_p`

重要的 output item 变体：

- message output
  - `type: "message"`
  - `role: "assistant"`
  - `status`
  - `content[]`
- reasoning output
  - `type: "reasoning"`
  - `summary?`
  - `encrypted_content?`
  - `status?`
- function call output
  - `type: "function_call"`
  - `call_id`
  - `name`
  - `arguments`
  - `status?`
- compaction output
  - `type: "compaction"`
  - `id`
  - `encrypted_content`

重要的 content block 变体：

- output text：`{ type: "output_text", text, annotations }`
- refusal：`{ type: "refusal", refusal }`

### 流事件形状

当前已建模的 `ResponseStreamEvent` 变体：

- `response.completed`
- `response.incomplete`
- `response.created`
- `error`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.failed`
- `response.output_item.added`
- `response.output_item.done`
- `response.reasoning_summary_text.delta`
- `response.reasoning_summary_text.done`
- `response.output_text.delta`
- `response.output_text.done`

---

## 4. `POST /embeddings`

### 主要源文件

- 上游客户端：`src/services/copilot/create-embeddings.ts`
- 本地路由处理器：`src/routes/embeddings/route.ts`

### 使用场景

- 直接本地 `POST /embeddings` 和 `POST /v1/embeddings`

### 请求 headers

- `copilotHeaders(ctx)`

### 请求体形状

`EmbeddingRequest`：

- `input: string | string[]`
- `model: string`

### 响应体形状

`EmbeddingResponse`：

- `object`
- `data[]`
  - `object`
  - `embedding: number[]`
  - `index`
- `model`
- `usage.prompt_tokens`
- `usage.total_tokens`

---

## 5. `GET /models`

### 主要源文件

- 上游客户端：`src/services/copilot/get-models.ts`
- header 构造：`src/lib/api-config.ts`

### 使用场景

- 上游 `/models` 用于 account/model 刷新与检查，由 `getModels()` 拉取并供本地模型状态使用
- 面向客户端的 `GET /models` 和 `GET /v1/models` 读取本地 `getAvailableModels()`，过滤 `blockedTargets` 后再合并 alias 返回

### 请求 headers

`getModels()` 使用 `copilotModelsHeaders()`。
在标准模式下，这从标准 GitHub Copilot header 集开始，然后将 intent 更改为模型访问。
在 opencode OAuth 模式下，它简化为较小的 header 集：

- `Authorization: Bearer {copilotToken or githubToken}`
- `User-Agent: opencode/{version}`

### 请求体

无。

### 响应体形状

`ModelsResponse`：

- `object`
- `data: Model[]`

当前已建模的 `Model` 字段：

- `billing?`
  - `is_premium?`
  - `multiplier?`
- `capabilities`
  - `family`
  - `limits`
    - `max_context_window_tokens?`
    - `max_output_tokens?`
    - `max_prompt_tokens?`
    - `max_inputs?`
  - `object`
  - `supports`
    - `max_thinking_budget?`
    - `min_thinking_budget?`
    - `tool_calls?`
    - `parallel_tool_calls?`
    - `dimensions?`
    - `streaming?`
    - `structured_outputs?`
    - `vision?`
    - `adaptive_thinking?`
  - `tokenizer`
  - `type`
- `id`
- `model_picker_enabled`
- `name`
- `object`
- `preview`
- `vendor`
- `version`
- `policy?`
  - `state`
  - `terms`
- `supported_endpoints?`

---

## 关键行为说明

### 1. `/v1/messages` 是唯一的多上游本地路由

本地 Anthropic 兼容路由最终可能调用：

- 上游 `/v1/messages`
- 上游 `/responses`
- 上游 `/chat/completions`

此决定是动态的，取决于运行时能力选择。

### 2. 请求形状取决于翻译路径

同一个终端用户交互可能被翻译为：

- 用于上游 `/v1/messages` 的 Anthropic 原生负载
- 用于上游 `/chat/completions` 的 OpenAI chat-completions 负载
- 用于上游 `/responses` 的 Responses 负载

### 3. Headers 在所有上游请求之间并不统一

以下场景存在差异：

- 标准 GitHub Copilot 模式与 opencode 模式
- 普通对话请求与 messages-proxy 请求
- 普通请求与模型访问请求
- vision 请求与非 vision 请求

### 4. 流合约因上游端点而异

- `/chat/completions` → OpenAI chat completion chunk 流
- `/v1/messages` → Anthropic 流事件
- `/responses` → Responses API 事件流

任何基于此代理构建的文档或工具都应考虑这三种不同的流协议。

---

## 主要源文件

### Base URL 和 headers
- `src/lib/api-config.ts`

### 上游客户端
- `src/services/copilot/create-chat-completions.ts`
- `src/services/copilot/create-messages.ts`
- `src/services/copilot/create-responses.ts`
- `src/services/copilot/create-embeddings.ts`
- `src/services/copilot/get-models.ts`

### 翻译 / 预处理
- `src/routes/messages/handler.ts`
- `src/routes/messages/anthropic-types.ts`
- `src/routes/messages/preprocess.ts`
- `src/routes/messages/non-stream-translation.ts`
- `src/routes/messages/responses-translation.ts`

### 直接本地路由处理器
- `src/routes/chat-completions/handler.ts`
- `src/routes/responses/handler.ts`
- `src/routes/embeddings/route.ts`

---

## 不在范围内

本文档**不**尝试描述：

- Copilot 之外的 provider-forwarding 路由
- 本地 admin API
- GitHub OAuth / GitHub REST API
- 向下游将响应翻译回 OpenAI / Anthropic 客户端格式的具体细节（仅保留识别上游响应结构所需的最小信息）
