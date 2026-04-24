# Copilot API Proxy

[English](./README.md) | 简体中文

> [!WARNING]
> 这是一个通过逆向工程实现的 GitHub Copilot API 代理，不受 GitHub 官方支持，并且可能随时异常失效。请自行承担使用风险。当前版本中，如果不使用 opencode OAuth，设备 ID 和机器 ID 会被发送给 GitHub Copilot。

> [!WARNING]
> **GitHub 安全提示：**  
> 过度自动化或脚本化地使用 Copilot（包括高频或批量请求，例如通过自动化工具发起）可能触发 GitHub 的滥用检测系统。  
> 你可能会收到 GitHub Security 的警告，进一步的异常活动还可能导致 Copilot 访问权限被暂时停用。
>
> GitHub 禁止使用其服务器进行过度批量自动化活动，或任何对其基础设施造成不当负载的行为。
>
> 请阅读：
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> 请负责任地使用本代理，避免账号受到限制。

---

> [!NOTE]
> [opencode](https://github.com/sst/opencode) 已经内置 GitHub Copilot provider，因此在基础使用场景下你未必需要本项目。如果你希望 OpenCode 通过 `@ai-sdk/anthropic` 接入 Copilot、保留 Anthropic Messages 的工具调用语义、让 Claude 系模型优先走原生 Messages API 而不是 Chat Completions API、使用带阶段感知的 gpt commentary，或者进一步优化 premium requests 的消耗，这个代理仍然很有价值。

---

## 重要说明

> [!IMPORTANT]
> **使用前请先注意以下几点：**
>
> 1. **Claude Code 配置：** 与 Claude Code 搭配使用时，请将模型 ID 配置为 `claude-opus-4-6` 或 `claude-opus-4.6`（不要带 `[1m]` 后缀，超出 GitHub Copilot 上下文窗口限制太多可能导致账号被封）。示例 `settings.json` 见 [通过 `settings.json` 手动配置](#manual-configuration-with-settingsjson)。
>
> 2. **推荐给 opencode 用户：** 与 opencode 搭配时，推荐优先使用 opencode OAuth app 启动。该方式与 opencode 内置的 GitHub Copilot provider 行为一致，且不存在 Terms of Service 风险：
>    ```sh
>    npx @nick3/copilot-api@latest --oauth-app=opencode start
>    ```
>
> 3. **通过 codex 使用时请关闭 multi agent：** 如果你是通过 GitHub Copilot 使用 codex，建议关闭 multi agent 功能。目前 GitHub Copilot 在 codex 场景下会按最后一条消息是否为 user role 计费，而这部分计费逻辑尚未调整。

---

## 项目概览

这是一个通过逆向工程实现的 GitHub Copilot API 代理，它将 Copilot 暴露为同时兼容 OpenAI 和 Anthropic 的服务。这样你就可以在任何支持 OpenAI Chat Completions / Responses API 或 Anthropic Messages API 的工具中使用 GitHub Copilot，包括把它作为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 的后端。

相比单纯把所有请求都转成 Chat Completions 兼容模式，这个代理可以对 Claude 系模型优先使用 Copilot 原生的 Anthropic 风格 Messages API，保留更多原生思考与工具调用语义，减少预热或恢复工具轮次时不必要的 Premium 请求消耗，并暴露带阶段感知的 `gpt-5.4` / `gpt-5.3-codex` 响应，让用户更容易跟踪模型正在做什么。

## 功能特性

- **OpenAI 与 Anthropic 双兼容**：以 OpenAI 兼容接口（`/v1/responses`、`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`）和 Anthropic 兼容接口（`/v1/messages`）对外暴露 GitHub Copilot。
- **Claude 模型优先走 Anthropic 原生路由**：当模型支持 Copilot 原生 `/v1/messages` 端点时，代理会优先使用它，而不是 `/responses` 或 `/chat/completions`，从而保留 Anthropic 风格的 `tool_use` / `tool_result` 流程以及更原生的 Claude 行为。
- **减少不必要的 Premium 请求**：通过把预热请求路由到 `smallModel`、将 `tool_result` 的后续消息重新并入工具流，以及把恢复的工具轮次视为延续流量而非全新高级交互，减少浪费的 premium 使用量。
- **分阶段的 `gpt-5.4` 与 `gpt-5.3-codex`**：这些模型可以在更深入推理或调用工具前先发出面向用户的 commentary，让长时间运行的编码操作更容易理解，而不是突然开始一串工具调用。
- **支持 Claude 原生 Beta 能力**：在 Messages API 路径上支持 Anthropic 原生能力，例如 `interleaved-thinking`、`advanced-tool-use` 和 `context-management`；这些能力在普通 Chat Completions 兼容模式下通常很难支持，或根本不可用。
- **Subagent 标记集成**：Claude Code 与 opencode 插件可以注入 `__SUBAGENT_MARKER__...`，并传递 `x-session-id`，从而让 subagent 流量保留正确的根会话以及 agent/user 语义。
- **通过 `@ai-sdk/anthropic` 接入 OpenCode**：可以将 OpenCode 指向这个代理作为 Anthropic provider，从而端到端保留 Anthropic Messages 语义、premium request 优化以及更原生的 Claude 行为。
- **Claude Code 集成**：可通过简单的命令行参数（`--claude-code`）快速配置并启动 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 使用 Copilot 作为后端。
- **用量看板**：提供基于 Web 的看板，用于监控你的 Copilot API 使用情况、查看额度以及详细统计数据。
- **Admin UI**：提供现代化管理控制台（`/admin`），可查看账号运行状态与请求历史，支持丰富过滤和请求详情 JSON 查看器（搜索/复制/下载），并包含主题（system/light/dark）与动效（magic/subtle/off）切换。
- **速率控制**：通过速率限制选项（`--rate-limit`）和等待机制（`--wait`）管理 API 使用，避免因请求过快而报错。
- **手动请求审批**：可对每个 API 请求进行手动批准或拒绝，实现更细粒度的使用控制（`--manual`）。
- **令牌可见性**：可在认证和刷新期间显示 GitHub 与 Copilot token，便于调试（`--show-token`）。
- **灵活认证方式**：既可交互式认证，也可以直接传入 GitHub token，适合 CI/CD 等非交互环境。
- **支持不同账号类型**：兼容个人版、Business 和 Enterprise 的 GitHub Copilot 方案。
- **多账号支持**：使用多个 GitHub Copilot 账号并自动路由：Premium 模型按账号顺序尝试，并在配额耗尽时自动回退；免费模型默认在多个账号之间轮转分发（可在 `config.json` 中配置）。
- **支持 opencode OAuth**：可通过设置环境变量 `COPILOT_API_OAUTH_APP=opencode` 或使用命令行参数 `--oauth-app=opencode` 来启用 opencode GitHub Copilot 认证。
- **支持 GitHub Enterprise**：可通过设置环境变量 `COPILOT_API_ENTERPRISE_URL`（例如 `company.ghe.com`）或命令行参数 `--enterprise-url=company.ghe.com` 连接到 GHE.com。
- **自定义数据目录**：可通过环境变量 `COPILOT_API_HOME` 或命令行参数 `--api-home=/path/to/dir` 修改默认数据目录（存放 token 和配置）。
- **多 Provider Anthropic 代理路由**：可以添加全局 provider 配置，并通过 `/:provider/v1/messages` 与 `/:provider/v1/models` 调用外部 Anthropic 兼容 API。
- **精确的 Claude Token 计数**：可以选择将 Claude 模型的 `/v1/messages/count_tokens` 请求转发到 Anthropic 的免费 token counting 端点，以获得精确计数，而不是依赖 GPT tokenizer 估算。
- **GPT 上下文管理**：可通过 `responsesApiContextManagementModels` 为长上下文 GPT 对话启用可配置的上下文压缩，在接近 token 限制时减少不必要的 Premium 请求。详见 [配置](#configuration-configjson)。

## 更好的 Agent 语义

### 在可用时优先使用原生 Anthropic Messages API

对于那些声明支持 Copilot `/v1/messages` 的模型，本项目会优先把请求发送到原生 Messages API，只有在需要时才回退到 `/responses` 或 `/chat/completions`。

相比仅通过 Chat Completions 兼容层使用 Claude 系模型，Messages API 路径能保留更多 Anthropic 原生行为，包括支持：

- `interleaved-thinking-2025-05-14`
- `advanced-tool-use-2025-11-20`
- `context-management-2025-06-27`

支持的 `anthropic-beta` 值会在原生 Messages 路径中过滤并透传；当请求了非自适应扩展思考的 thinking budget 时，也会自动添加 `interleaved-thinking`。

### 减少不必要的 Premium 请求

这个代理内置了一些请求计费保护逻辑，专门面向重工具调用的编码工作流：

- 无工具的预热或探测请求可以强制走 `smallModel`，避免后台检查消耗 premium 使用量；
- 混合了 `tool_result` 和补充提示文本的消息块会重新并入 `tool_result` 流，而不会被当成新的用户轮次计费；
- `x-initiator` 会根据最新一条消息或 item 推导，而不是依赖陈旧的 assistant 历史。

这样可以让恢复的工具轮次被视为既有工作流的延续，而不是一条全新的 Premium 请求。

### 分阶段的 `gpt-5.4` 与 `gpt-5.3-codex`

默认情况下，内置的 `extraPrompts` 会为 `gpt-5.4` 与 `gpt-5.3-codex` 启用中间进度更新行为，代理会在工具调用前把 assistant 轮次翻译成 `phase: "commentary"`，并在最终回复时使用 `phase: "final_answer"`。

这样客户端在更深入的推理或工具执行开始前，就能先收到一段简短、面向用户的说明。

### Subagent 标记集成

对于基于 subagent 的客户端，本项目可以保留根会话上下文，并正确识别来自 subagent 的流量。

这一标记流程会在 `<system-reminder>` 中放入 `__SUBAGENT_MARKER__...`，同时传递根级 `x-session-id`。当检测到该标记后，代理可以保留父会话身份、推导 `x-initiator: agent`，并把交互标记为 subagent 流量，而不是新的顶层请求。

项目中已经为 Claude Code 和 opencode 都提供了插件集成；配置方法见下文 [插件集成](#plugin-integrations)。

<a id="accurate-claude-token-counting"></a>

### 精确的 Claude Token 计数

默认情况下，`/v1/messages/count_tokens` 会使用 GPT 的 `o200k_base` tokenizer，并乘以 1.15 倍来估算 Claude token 数。这个估算通常会低于 Claude 的真实 token 使用量，导致像 Claude Code 这类工具压缩上下文太晚，从而触发 “prompt token count exceeds limit” 之类的错误。

当配置了 Anthropic API key 后，代理会把 Claude 模型的 token 计数请求转发到 [Anthropic 真实的 `/v1/messages/count_tokens` 端点](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)。这样能返回精确计数，消除估算误差。不属于 Claude 的模型，以及转发失败的情况，会自动回退到 GPT tokenizer 估算。

**设置方式：**

1. 在 [console.anthropic.com](https://console.anthropic.com) 创建 Anthropic API 账户，并至少充值 5 美元信用额度（这是激活 API key 所需条件，但 token counting 端点本身是免费的）
2. 在 Settings > API Keys 中创建一个 API key
3. 通过以下 **任一** 方式配置：
   - `config.json`：设置 `"anthropicApiKey": "sk-ant-..."`
   - 环境变量：`ANTHROPIC_API_KEY=sk-ant-...`

> [!NOTE]
> Anthropic 的 `/v1/messages/count_tokens` 端点是 **免费的**（不会按 token 收费）。在 Tier 1 下速率限制为 100 RPM。这里要求预充值 5 美元，只是为了激活 API 访问权限，token counting 调用本身不产生费用。

## 前置要求

- Bun（>= 1.2.x）
- 已订阅 Copilot 的 GitHub 账号（个人版、Business 或 Enterprise）

## 安装

安装依赖：

```sh
bun install
```

直接从源码启动服务：

```sh
bun run start start
```

## 通过 npx 使用

你可以直接用 npx 运行本项目：

```sh
npx @nick3/copilot-api@latest start
```

带参数示例：

```sh
npx @nick3/copilot-api@latest start --port 8080
```

如果只想做认证：

```sh
npx @nick3/copilot-api@latest auth
```

## 配合 Docker 使用

构建镜像：

```sh
docker build -t copilot-api .
```

运行容器：

```sh
# 在宿主机创建目录，用于持久化 GitHub token 及相关数据
mkdir -p ./copilot-data

# 通过 bind mount 持久化 token
# 这样容器重启后认证信息仍会保留

docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

> **注意：**
> GitHub token 及相关数据会保存在宿主机的 `copilot-data` 目录中。该目录会映射到容器内的 `/root/.local/share/copilot-api`，从而在容器重启后继续保留数据。这个目录还会保存 `/admin` 使用的管理端请求历史数据库（`admin.sqlite`）。

### 在 Docker 中添加多个账号

如果你在 Docker 中运行并希望添加多个账号：

> **注意：** Docker 镜像默认使用的 entrypoint 会直接执行 `start` 命令。因此如果你想在容器内运行 `auth` 子命令，需要加上 `--auth` 前缀（例如 `--auth add`）。

```sh
# 交互式添加账号（一次一个）
docker run -it -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api --auth add
docker run -it -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api --auth add

# 列出已注册账号
docker run -it -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api --auth ls -q
```

> **注意：** 使用多账号时，所有账号数据（token 与注册表）都会保存在挂载的 `copilot-data` 目录中。
> Premium 模型请求会按账号顺序尝试，并在 premium 配额耗尽时自动切换；免费模型请求默认会在多个账号间轮转分发（可在 `config.json` 中配置）。

### 在 Docker 中使用环境变量

你也可以直接通过环境变量把 GitHub token 传给容器：

```sh
# 构建时注入 GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api .

# 运行时注入 GitHub token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api

# （可选）启用远程 Admin UI/API 访问
# 这需要设置 ADMIN_TOKEN，并通过请求头发送（x-admin-token / Authorization: Bearer）
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here -e ADMIN_TOKEN=your_admin_token_here copilot-api

# （可选）启用请求鉴权
# 推荐方式：在 config.json 中配置 auth.apiKeys。
# 兼容迁移场景时，仍支持旧的 COPILOT_API_KEY。
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here -e COPILOT_API_KEY=your_api_key_here copilot-api

# 搭配附加选项运行
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api --verbose --port 4141
```

### Docker Compose 示例

```yaml
version: "3.8"
services:
  copilot-api:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
      - ADMIN_TOKEN=your_admin_token_here
      - COPILOT_API_KEY=your_api_key_here
    restart: unless-stopped
```

Docker 镜像包含：

- 多阶段构建，以优化镜像体积
- 非 root 用户，以增强安全性
- 用于容器监控的健康检查
- 固定基础镜像版本，以保证可复现构建

## 命令结构

Copilot API 现在使用子命令结构，主要命令包括：

- `start`：启动 Copilot API 服务。如有需要，也会自动处理认证。
- `auth`：管理 GitHub Copilot 账号。支持以下子命令：
  - `auth add`：通过 GitHub OAuth 流程添加新账号
  - `auth ls`：列出所有已注册账号（使用 `-q` 显示配额）
  - `auth rm <id|index>`：按账号 ID 或 1-based 索引删除账号

  为兼容旧行为，不带子命令直接执行 `auth` 时，默认等价于 `auth add`。
- `check-usage`：直接在终端中显示当前 GitHub Copilot 用量与额度信息（无需启动服务）。
- `debug`：显示诊断信息，包括版本、运行时详情、文件路径以及认证状态，便于排障与支持。

## 命令行选项

### 全局选项

以下选项可用于任意子命令。若在子命令之前传入，请使用 `--key=value` 形式：

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| `--api-home` | API home 目录路径（设置 `COPILOT_API_HOME`） | 无 | 无 |
| `--oauth-app` | OAuth app 标识符（设置 `COPILOT_API_OAUTH_APP`） | 无 | 无 |
| `--enterprise-url` | GitHub Enterprise URL（设置 `COPILOT_API_ENTERPRISE_URL`） | 无 | 无 |

### Start 命令选项

以下是 `start` 命令可用的命令行选项：

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| `--port` | 监听端口 | `4141` | `-p` |
| `--verbose` | 启用详细日志 | `false` | `-v` |
| `--account-type` | 使用的账号类型（individual、business、enterprise） | `individual` | `-a` |
| `--manual` | 启用手动请求审批 | `false` | 无 |
| `--rate-limit` | 请求之间的速率限制秒数 | 无 | `-r` |
| `--wait` | 达到速率限制时等待，而不是直接报错 | `false` | `-w` |
| `--github-token` | 直接提供 GitHub token（必须通过 `auth` 子命令生成） | 无 | `-g` |
| `--claude-code` | 生成一个使用 Copilot API 配置启动 Claude Code 的命令 | `false` | `-c` |
| `--show-token` | 在获取和刷新时显示 GitHub 与 Copilot token | `false` | 无 |
| `--proxy-env` | 从环境变量初始化代理 | `false` | 无 |

### Auth 命令选项

`auth` 命令提供三个子命令来管理多账号：

#### `auth add` - 添加新账号

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| `--account-type` | 账号类型（individual、business、enterprise） | `individual` | `-a` |
| `--verbose` | 启用详细日志 | `false` | `-v` |
| `--show-token` | 认证后显示 GitHub token | `false` | 无 |

#### `auth ls` - 列出已注册账号

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| `--show-quota` | 显示配额信息（需要发起 API 调用） | `false` | `-q` |
| `--verbose` | 启用详细日志 | `false` | `-v` |

#### `auth rm <target>` - 删除账号

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| `--force` | 跳过确认提示 | `false` | `-f` |
| `--verbose` | 启用详细日志 | `false` | `-v` |

其中 `<target>` 可以是账号 ID（GitHub 用户名），也可以是 1-based 索引。

### Debug 命令选项

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| `--json` | 以 JSON 输出调试信息 | `false` | 无 |

<a id="configuration-configjson"></a>

## 配置（config.json）

- **位置：** Linux/macOS 为 `~/.local/share/copilot-api/config.json`，Windows 为 `%USERPROFILE%\.local\share\copilot-api\config.json`。
- **默认结构：**
  ```json
  {
    "auth": {
      "apiKeys": []
    },
    "providers": {},
    "extraPrompts": {
      "gpt-5-mini": "<built-in exploration prompt>",
      "gpt-5.3-codex": "<built-in commentary prompt>",
      "gpt-5.4-mini": "<built-in commentary prompt>",
      "gpt-5.4": "<built-in commentary prompt>"
    },
    "smallModel": "gpt-5-mini",
    "accountAffinity": true,
    "responsesApiContextManagementModels": [],
    "modelReasoningEfforts": {
      "gpt-5-mini": "low",
      "gpt-5.3-codex": "xhigh",
      "gpt-5.4-mini": "xhigh",
      "gpt-5.4": "xhigh"
    },
    "allowOriginalModelNamesForAliases": false,
    "useFunctionApplyPatch": true,
    "forceAgent": false,
    "compactUseSmallModel": true,
    "messageStartInputTokensFallback": false,
    "modelRefreshIntervalHours": 24,
    "sessionAffinityRetentionDays": 7,
    "useMessagesApi": true,
    "useResponsesApiWebSearch": true,
    "logLevel": "info"
  }
  ```
- **auth.apiKeys：** 用于请求认证的 API key。支持多个 key 轮换使用。请求可通过 `x-api-key: <key>` 或 `Authorization: Bearer <key>` 进行认证。若为空或省略，则禁用认证。
- **extraPrompts：** `model -> prompt` 的映射。把 Anthropic 风格请求翻译给 Copilot 时，会将其附加到第一条 system prompt 后面。你可以借此为不同模型注入护栏或指引。缺失的默认项会自动补齐，但不会覆盖你自定义的 prompt。内置的 `gpt-5.3-codex`、`gpt-5.4-mini` 与 `gpt-5.4` prompt 会启用带阶段感知的 commentary，让模型在工具调用或更深层推理前先发出简短的、用户可见的进度说明。
- **providers：** 全局上游 provider 映射。每个 provider key（例如 `custom`）都会变成一个路由前缀（`/custom/v1/messages`）。目前仅支持 `type: "anthropic"`。
  - `enabled`：若省略则默认为 `true`。
  - `baseUrl`：provider API 的基础 URL，不要带结尾的 `/v1/messages`。
  - `apiKey`：作为上游凭据值使用。
  - `authType`（可选）：控制 `apiKey` 如何发送到上游。支持 `x-api-key`（默认）和 `authorization`。当设置为 `authorization` 时，代理会发送 `Authorization: Bearer <apiKey>`。
  - `adjustInputTokens`（可选）：当为 `true` 时，代理会在 usage 响应里用 `input_tokens` 减去 `cache_read_input_tokens` 和 `cache_creation_input_tokens`。
  - `models`（可选）：按模型 ID 配置的映射。每个键都是请求中的模型名，值支持：
    - `temperature`（可选）：请求未指定时使用的默认温度。
    - `topP`（可选）：请求未指定时使用的默认 `top_p`。
    - `topK`（可选）：请求未指定时使用的默认 `top_k`。

  provider 配置示例：

  ```json
  {
    "providers": {
      "custom": {
        "type": "anthropic",
        "enabled": true,
        "baseUrl": "https://your-provider.example",
        "apiKey": "sk-your-provider-key",
        "authType": "x-api-key",
        "adjustInputTokens": false,
        "models": {
          "kimi-k2.5": {
            "temperature": 1,
            "topP": 0.95
          }
        }
      }
    }
  }
  ```
- **responsesApiContextManagementModels：** 需要注入 Responses API `context_management` 压缩指令的模型 ID 列表。适用于支持服务端上下文管理的模型，并且你希望代理在后续轮次中只保留最新的压缩承载内容。
- **smallModel：** 用于无工具预热消息、compact/background 请求以及其他短小维护型轮次（例如 Claude Code 或 OpenCode 发出的 housekeeping 请求）的回退模型，用来避免消耗 premium requests；默认是 `gpt-5-mini`。如果原始模型名被屏蔽，而这里指向的是某个别名目标模型，则会解析为首选别名。
- **accountAffinity：** 是否根据 session 标识启用粘性账号路由。开启后，同一 session 针对同一模型的请求会优先路由到上次成功处理它的账号。该策略同时适用于免费模型和付费模型。默认值为 `true`。设为 `false` 则所有模型都改为顺序路由。
- **apiKey（已弃用）：** 兼容迁移的旧单 key 字段。优先使用 `auth.apiKeys`。当 `auth.apiKeys` 为空时，服务端会回退到 `COPILOT_API_KEY`，再回退到 `apiKey`。
- **modelReasoningEfforts：** 按模型配置发送到 Copilot Responses API 的 `reasoning.effort`。可选值包括 `none`、`minimal`、`low`、`medium`、`high` 和 `xhigh`。若某模型未配置，则默认使用 `high`。
- **modelAliases：** `alias -> { target, allowOriginal? }` 的映射（也仍然接受旧的字符串写法）。别名 key 会先做标准化（trim + lowercase），且不能为空；别名不能映射回自己（大小写不敏感），冲突的标准化别名会被拒绝。`allowOriginal` 可为单个别名覆盖全局默认值。如果多个别名映射到同一个 target，只要其中任意一个设置了 `allowOriginal: true`，原始模型名就会被允许（allow-wins）。Admin UI/API 会拒绝被屏蔽的键（`__proto__`、`constructor`、`prototype`）。下游请求可以直接使用这些别名。
- **allowOriginalModelNamesForAliases：** 对未显式设置 `allowOriginal` 的别名所采用的全局默认值。当其为 `false`（默认）时，target 原名默认被屏蔽，除非某个别名显式允许；当其为 `true` 时，target 原名默认可用，除非所有别名都显式阻止。
- **useFunctionApplyPatch：** 当为 `true`（默认）时，`POST /v1/responses` 会把 `tools` 中形如 `{ "type": "custom", "name": "apply_patch" }` 的条目转换为 OpenAI 风格的 `function` 工具（带参数 schema），以便与上游更好兼容。设为 `false` 则保留自定义工具原样。
- **forceAgent：** 当为 `true` 时，只要 `POST /v1/responses` 的任一 input item 带有 `role: "assistant"`，就会把请求视为由 agent 发起；当为 `false`（默认）时，只检查最后一个 input item。
- **compactUseSmallModel：** 当为 `true` 时，检测到的“compact”请求（例如 Claude Code 或 opencode 的 compact 模式）会自动改用配置中的 `smallModel`，以避免短后台任务消耗 premium 使用量。默认值为 `true`。
- **messageStartInputTokensFallback：** 当为 `true` 时，如果上游流式事件没有提供 `message_start.input_tokens`，Anthropic 流式翻译层会自行估算该值。默认值为 `false`。
- **modelRefreshIntervalHours：** 后台刷新账号模型列表的间隔小时数。设为 `0` 可关闭自动刷新。默认值为 `24`。
- **sessionAffinityRetentionDays：** session affinity 绑定的保留天数。默认值为 `7`。
- **useMessagesApi：** 当为 `true`（默认）时，支持 Copilot 原生 `/v1/messages` 端点的 Claude 系模型会走 Messages API 路径。设为 `false` 时，将跳过 Messages API 候选，回退到 `/responses`（如支持）或 `/chat/completions`。
- **useResponsesApiWebSearch：** 当为 `true`（默认）时，`/v1/responses` 会保留 `type: "web_search"` 的工具并转发到上游。设为 `false` 则会在发送 Copilot 请求之前将其剥离。
- **logLevel：** 控制 `logs/*.log` 下 handler 文件日志的详细级别。可选值：`error`、`warn`、`info`、`debug`。默认值为 `info`。如果你需要把 payload 级或 stream 级的调试内容写入文件日志，请显式设置为 `debug`。
- **anthropicApiKey：** 可选的 Anthropic API key，用于精确的 Claude token 计数（见下文 [精确的 Claude Token 计数](#accurate-claude-token-counting)）。也可通过环境变量 `ANTHROPIC_API_KEY` 设置。未配置时会回退到 GPT tokenizer 估算。

`--verbose` 不再隐式开启 debug 级别文件日志。如果你需要 `logs/*.log` 下更详细的 handler 日志，请在 `config.json` 中显式设置 `"logLevel": "debug"`。

编辑此文件即可自定义 prompts，或替换为你自己的快速模型。如果手动修改了这个文件，请重启服务（或调用 `GET /api/admin/config`）以刷新缓存中的配置。通过 Admin UI/API 做出的修改会经过校验、写盘并立即生效；未知键会被拒绝。

## API 认证

- **受保护路由：** 当配置了有效 API key 时，除 `/`、`/admin` 和 `/api/admin/*` 之外的所有路由都需要认证。
- **有效 key 的解析顺序：** 优先使用 `auth.apiKeys`。如果为空，则回退到旧的 `COPILOT_API_KEY`，再回退到 `config.json` 中的 `apiKey`。
- **允许的认证头：**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS 预检：** `OPTIONS` 请求始终允许。
- **未配置 key 时：** 服务会正常启动，并允许请求通过（即禁用认证）。
- **Admin 路由：** `/admin` 和 `/api/admin/*` 不走这一层中间件，而是继续使用 admin 专用的访问控制（`localhost` / `ADMIN_TOKEN`）。

示例请求：

```sh
curl http://localhost:4141/v1/models \
  -H "x-api-key: your_api_key"
```

## API 端点

服务端提供多个端点来与 Copilot API 交互。它支持 OpenAI 兼容端点，也支持 Anthropic 兼容端点，因此可以更灵活地接入不同工具与服务。

### OpenAI 兼容端点

这些端点模拟 OpenAI API 结构。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `POST /v1/responses` | `POST` | OpenAI 中用于生成模型响应的高级接口。 |
| `POST /v1/chat/completions` | `POST` | 为给定聊天对话创建模型响应。 |
| `GET /v1/models` | `GET` | 列出当前可用模型。 |
| `POST /v1/embeddings` | `POST` | 创建表示输入文本的向量嵌入。 |

### Anthropic 兼容端点

这些端点设计为兼容 Anthropic Messages API。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `POST /v1/messages` | `POST` | 为给定对话创建模型响应。 |
| `POST /v1/messages/count_tokens` | `POST` | 计算一组消息的 token 数。 |
| `POST /:provider/v1/messages` | `POST` | 将 Anthropic Messages API 代理到已配置的 provider。 |
| `GET /:provider/v1/models` | `GET` | 将 Anthropic Models API 代理到已配置的 provider。 |
| `POST /:provider/v1/messages/count_tokens` | `POST` | 为 provider 路由请求在本地计算 token 数。 |

### 使用量监控端点

用于监控 Copilot 账号运行状态和按账号划分的详细用量信息。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `GET /usage` | `GET` | 获取所有已加载账号的运行状态快照（ID、剩余额度、是否无限量）。 |
| `GET /usage/:accountIndex` | `GET` | 获取指定账号索引的详细 Copilot 用量（0-based，包含 `quota_snapshots`）。 |
| `GET /token` | `GET` | 获取当前 API 正在使用的 Copilot token。 |

> **关于账号索引的说明**
> - `/usage/:accountIndex` 使用 **0-based** 索引。
> - 如果你通过 `start --github-token ...` 启动服务，会额外加入一个临时账号，并在 `GET /usage` 中显示为 `"(temporary)"`。此时 `accountIndex=0` 指向临时账号，已注册账号从 `accountIndex=1` 开始。
> - `auth rm <index>` 使用的是 **1-based** 索引（与 `auth ls` 输出一致）。

示例：

```sh
# 账号运行状态列表
curl "http://localhost:4141/usage"

# 查看索引为 0 的账号详细用量
curl "http://localhost:4141/usage/0"
```

> **API Key 提示：** 如果启用了 API key 鉴权，访问 `/usage` 相关端点时也需要带上 `Authorization: Bearer <key>` 或 `x-api-key`。

### 旧认证方式兼容

为了兼容旧部署的迁移，服务端仍接受：

- `COPILOT_API_KEY`（环境变量）
- `config.json` 中的 `apiKey`

只有在 `auth.apiKeys` 为空时，才会启用这些兼容项。新部署应直接使用 `auth.apiKeys`。

### Admin UI 与 Admin API

服务端还内置了 Admin UI 与 Admin API，用于查看代理记录下来的账号状态和请求历史。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `GET /admin` | `GET` | 内置 Admin UI（单页 Web 应用）。 |
| `GET /api/admin/meta` | `GET` | Admin DB 元信息（数据库路径、保留策略等）。 |
| `GET /api/admin/accounts` | `GET` | 列出账号及其运行状态，并可选返回聚合统计。 |
| `GET /api/admin/requests` | `GET` | 使用过滤条件和 cursor 分页查询请求日志。 |
| `GET /api/admin/requests/:requestId` | `GET` | 按请求 ID 获取单条请求日志。 |

#### 认证与访问控制

- 当主机名为 `localhost`、`127.0.0.1` 或 `::1` 时，默认允许 loopback 访问。
- 远程访问默认关闭，除非你在服务端设置了 `ADMIN_TOKEN`。
- 设置了 `ADMIN_TOKEN` 后，请通过以下任一方式传递 token：
  - `x-admin-token: <token>`
  - `Authorization: Bearer <token>`
- 出于安全考虑，不支持通过 URL query 参数传 token。

#### Requests 查询（分页与过滤）

- `limit` 默认是 50，最大不超过 200。
- `cursor_id` 是分页用的整数游标（使用上一次响应中的 `next_cursor_id`）。
- 可用过滤条件：`account_id`、`upstream_model`、`client_model`、`upstream_endpoint`、`path`、`status`、`has_error`、`from_ms`、`to_ms`。
- 响应字段：`items`、`next_cursor_id`、`has_more`。

## 使用示例

通过 npx 使用：

```sh
# 基础启动
npx @nick3/copilot-api@latest start

# 自定义端口并开启详细日志
npx @nick3/copilot-api@latest start --port 8080 --verbose

# 使用 GitHub Business 方案账号
npx @nick3/copilot-api@latest start --account-type business

# 使用 GitHub Enterprise 方案账号
npx @nick3/copilot-api@latest start --account-type enterprise

# 对每个请求启用手动审批
npx @nick3/copilot-api@latest start --manual

# 将请求间隔限制为 30 秒
npx @nick3/copilot-api@latest start --rate-limit 30

# 命中速率限制时等待，而不是直接报错
npx @nick3/copilot-api@latest start --rate-limit 30 --wait

# 直接传入 GitHub token
npx @nick3/copilot-api@latest start --github-token ghp_YOUR_TOKEN_HERE

# 仅执行认证流程
npx @nick3/copilot-api@latest auth

# 认证时启用详细日志
npx @nick3/copilot-api@latest auth --verbose

# 添加多个账号（账号会按添加顺序记录）
npx @nick3/copilot-api@latest auth add
npx @nick3/copilot-api@latest auth add  # 添加第二个账号

# 列出所有已注册账号
npx @nick3/copilot-api@latest auth ls

# 列出账号并显示配额信息
npx @nick3/copilot-api@latest auth ls -q

# 按索引删除账号（1-based）
npx @nick3/copilot-api@latest auth rm 2

# 按 ID 删除账号（GitHub 用户名）
npx @nick3/copilot-api@latest auth rm octocat

# 在终端中查看 Copilot 用量与额度（无需启动服务）
npx @nick3/copilot-api@latest check-usage

# 输出调试信息，便于排障
npx @nick3/copilot-api@latest debug

# 以 JSON 格式输出调试信息
npx @nick3/copilot-api@latest debug --json

# 从环境变量初始化代理（HTTP_PROXY、HTTPS_PROXY 等）
npx @nick3/copilot-api@latest start --proxy-env

# 使用 opencode GitHub Copilot 认证
COPILOT_API_OAUTH_APP=opencode npx @nick3/copilot-api@latest start

# 通过命令行设置自定义 API home 目录
npx @nick3/copilot-api@latest --api-home=/path/to/custom/dir start

# 通过命令行使用 GitHub Enterprise
npx @nick3/copilot-api@latest --enterprise-url=company.ghe.com start

# 通过命令行使用 opencode OAuth
npx @nick3/copilot-api@latest --oauth-app=opencode start

# 组合多个全局选项
npx @nick3/copilot-api@latest --api-home=/custom/path --oauth-app=opencode --enterprise-url=company.ghe.com start
```

### Opencode OAuth 认证

你可以使用 opencode GitHub Copilot 认证，替代默认的认证方式：

```sh
# 在执行任何命令前先设置环境变量
export COPILOT_API_OAUTH_APP=opencode

# 然后执行 start 或 auth 命令
npx @nick3/copilot-api@latest start
npx @nick3/copilot-api@latest auth
```

也可以使用内联环境变量：

```sh
COPILOT_API_OAUTH_APP=opencode npx @nick3/copilot-api@latest start
```

## 与 OpenCode 一起使用

OpenCode 已经内置了 GitHub Copilot provider。本节适用于你希望让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个代理，并复用本 README 前面提到的 agent 行为时。

### 最小配置

使用 OpenCode OAuth app 启动代理：

```sh
npx @nick3/copilot-api@latest --oauth-app=opencode start
```

然后让 OpenCode 通过 `@ai-sdk/anthropic` 指向该代理。

示例 `~/.config/opencode/opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "local/gpt-5.4",
  "small_model": "local/gpt-5-mini",
  "agent": {
    "build": {
      "model": "local/gpt-5.4"
    },
    "plan": {
      "model": "local/gpt-5.4"
    },
    "explore": {
      "model": "local/gpt-5-mini"
    }
  },
  "provider": {
    "local": {
      "npm": "@ai-sdk/anthropic",
      "name": "Copilot API Proxy",
      "options": {
        "baseURL": "http://localhost:4141/v1",
        "apiKey": "dummy"
      },
      "models": {
        "gpt-5.4": {
          "name": "gpt-5.4",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 272000,
            "output": 128000
          }
        },
        "gpt-5-mini": {
          "name": "gpt-5-mini",
          "limit": {
            "context": 128000,
            "output": 64000
          }
        },
        "claude-sonnet-4.6": {
          "id": "claude-sonnet-4.6",
          "name": "claude-sonnet-4.6",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 128000,
            "output": 32000
          },
          "options": {
            "thinking": {
              "type": "enabled",
              "budgetTokens": 31999
            }
          }
        }
      }
    }
  }
}
```

这些字段的重要性：

- `npm: "@ai-sdk/anthropic"` 是关键。OpenCode 会以 Anthropic Messages 语义与该代理通信，而不是把一切扁平化为 OpenAI Chat Completions。
- `options.baseURL` 应设为 `http://localhost:4141/v1`；Anthropic SDK 会自动补上 `/messages`、`/models` 和 `/messages/count_tokens`。
- `model`、`small_model` 与 `agent.*.model` 让你可以把 `gpt-5.4` 用于 build/plan，同时把探索和后台工作路由到 `gpt-5-mini`。
- 如果你在此代理中启用了 `auth.apiKeys`，请把 `dummy` 替换为真实 key；否则任意占位值都可以。

## 使用量查看器

### Admin API 示例

```sh
# 本地回环访问（无需 token）
curl "http://localhost:4141/api/admin/meta"

# 启用远程 Admin UI/API 访问（服务端）
# ADMIN_TOKEN=your_admin_token_here npx @nick3/copilot-api@latest start

# 远程访问（需要 token）
curl -H "x-admin-token: your_admin_token_here" "http://localhost:4141/api/admin/accounts?include_stats=1"

# 请求日志（过滤 + 分页）
curl "http://localhost:4141/api/admin/requests?limit=50&has_error=1"
# 使用响应里的 next_cursor_id 继续翻页：
curl "http://localhost:4141/api/admin/requests?limit=50&cursor_id=<next_cursor_id>"

# 单条请求详情
curl "http://localhost:4141/api/admin/requests/<requestId>"
```

## 使用 Admin UI（/admin）

代理内置了一个随服务实例一起提供的 Admin UI。你可以用它查看代理捕获的账号状态与请求历史（模型/端点、tokens/usage、耗时以及错误摘要等）。

1. 启动服务。例如使用 npx：
   ```sh
   npx @nick3/copilot-api@latest start
   ```
2. 在浏览器中打开：
   - `http://localhost:4141/admin`（如果改过端口，请替换为对应端口）

### UI 提示

- **顶部右上角控制项**
  - **Motion**：`Magic` / `Subtle` / `Off`（如果你的系统启用了 reduced motion，会自动强制为 `Off`）
  - **Theme**：`System` / `Light` / `Dark`
  - **Admin token**：保存在 `sessionStorage` 中（可通过 Token 对话框保存和测试）
- **导航**
  - **Accounts**：提供 KPI 概览（包括错误率、tokens/request）、过滤与排序；点击某个账号可带着过滤条件跳转到 Requests。
  - **Requests**：支持 Quick/Advanced filters、时间范围预设（15m/1h/6h/24h/7d）与自定义日期时间、cursor 分页。
  - **Request detail**：返回按钮会回到 Requests（从列表进入时会保留过滤条件）；摘要字段支持反向跳转回 Requests；JSON 查看器支持搜索/高亮、展开/折叠，以及 Copy/Download。
- **深链接**
  - Admin UI 使用 hash 路由，因此可分享的链接形如：`http://localhost:4141/admin/#/requests?...`

### 访问控制

- 通过 `localhost` / `127.0.0.1` / `::1` 访问时，admin API 无需 token。
- 对于非 loopback 访问（例如机器 IP 或主机名），你必须在服务端设置 `ADMIN_TOKEN` 以启用远程访问，并在请求中带上该 token。

UI 会把 token 保存在 `sessionStorage` 中，并通过 `x-admin-token` 请求头发送（不会出现在 URL 中）。

如果你看到：
- `403 forbidden`：说明 admin API 仍限制为 localhost，除非设置了 `ADMIN_TOKEN`（或者请求被判定为跨源而拦截）。
- `401 unauthorized`：说明虽然已经设置了 `ADMIN_TOKEN`，但请求没有携带有效 token。

### 数据存储（admin.sqlite）

- 请求历史保存在应用数据目录下的 `admin.sqlite` 中：
  - Linux/macOS：`~/.local/share/copilot-api/admin.sqlite`
  - Windows：`%USERPROFILE%\.local\share\copilot-api\admin.sqlite`
- 默认保留最多 14 天日志，数据库上限为 200,000 行（更旧的数据会自动清理）。
- 出于安全考虑，admin DB 只保存元数据，不保存 GitHub/Copilot token，也不保存请求/响应正文。

## 与 Claude Code 一起使用

这个代理可以为 [Claude Code](https://docs.anthropic.com/en/claude-code) 提供后端能力。Claude Code 是 Anthropic 提供的实验性面向开发者的对话式 AI 助手。

有两种方式可以把 Claude Code 配置为使用这个代理：

### 通过 `--claude-code` 标志进行交互式配置

执行带 `--claude-code` 的 `start` 命令开始：

```sh
npx @nick3/copilot-api@latest start --claude-code
```

你会被提示选择一个主模型，以及一个用于后台任务的 “small, fast” 模型。选择完成后，会有一条命令被复制到剪贴板中。该命令会设置 Claude Code 使用该代理所需的环境变量。

在新的终端中粘贴并执行这条命令，即可启动 Claude Code。

> **API Key 提示：** 如果启用了请求鉴权（推荐 `auth.apiKeys`；旧的 `COPILOT_API_KEY` / `apiKey` 也仍可用），请将 `ANTHROPIC_AUTH_TOKEN` 设置为其中一个可用 API key。

<a id="manual-configuration-with-settingsjson"></a>

### 通过 `settings.json` 手动配置

另一种方式是在项目根目录中创建 `.claude/settings.json` 文件，并写入 Claude Code 所需的环境变量。这样你就不需要每次都运行交互式配置了。

下面是一个 `.claude/settings.json` 示例：

> **API Key 提示：** 如果启用了请求鉴权，请将 `ANTHROPIC_AUTH_TOKEN` 设为你的某个 API key，这样 Claude Code 才能发送 `x-api-key`。如果未启用鉴权，则任意值都可以。

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5-mini",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
    "CLAUDE_PLUGIN_ENABLE_QUESTION_RULES": "true"
  },
  "permissions": {
    "deny": [
      "WebSearch",
      "mcp__ide__executeCode"
    ]
  }
}
```

- 请根据需要替换 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。配置完成后，请安装 Claude Code 插件，见 [插件集成](#plugin-integrations)。如果你配置的是 Claude 模型，建议把这些模型配置尽量设为一致，以保持与 GitHub Copilot Claude agent 行为一致。
- 将 `CLAUDE_CODE_ATTRIBUTION_HEADER` 设为 `0` 可以阻止 Claude Code 在 system prompt 中附加计费和版本信息，从而避免 prompt cache 失效。
- 关闭 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` 和 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` 可以避免不必要地消耗额度。
- `permissions` 中默认禁止 `WebSearch`，因为当前项目下 GitHub Copilot API 还不支持原生 web search。你可以继续在 Claude Code 的 `permissions` 中拒绝 `WebSearch`，或在 `config.json` 中将 `useResponsesApiWebSearch` 设为 `false`。如果需要搜索能力，建议使用 `mcp_server_fetch` 等替代工具。
- 请不要启用 `ENABLE_TOOL_SEARCH`。Claude Code 当前使用的是客户端 tool search 模式；每次加载 deferred tools 都需要额外请求，会影响缓存命中率，而且本项目目前与该模式仍存在兼容性问题，启用后也可能引发错误。

<a id="claudemd-or-agentsmd-recommended-content"></a>

### CLAUDE.md 或 AGENTS.md 推荐内容

如果你想手动加入这些提醒，请在 Claude Code 的 `CLAUDE.md`，或 opencode/codex 的 `AGENTS.md` 中加入以下内容：

```
- Prohibited from directly asking questions to users, MUST use question tool.
- Once you can confirm that the task is complete, MUST use question tool to make user confirm. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again, after try again, MUST use question tool to make user confirm again.
```

更多选项见：[Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

也可以参考 IDE 集成说明：[Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

<a id="plugin-integrations"></a>

## 插件集成

插件集成同时适用于 Claude Code 与 opencode。

#### Claude Code 插件集成（基于 marketplace）

Claude Code 集成被打包为名为 `claude-plugin` 的插件。

- 本仓库中的 marketplace catalog：`.claude-plugin/marketplace.json`
- 本仓库中的插件源码：`claude-plugin`

远程添加 marketplace：

```sh
/plugin marketplace add https://github.com/nick3/copilot-api.git#all
```

从 marketplace 安装插件：

```sh
/plugin install claude-plugin@copilot-api-marketplace
```

安装后，插件会在 `SubagentStart` 时注入 `__SUBAGENT_MARKER__...`，该代理会利用它推导 `x-initiator: agent`。

插件还会注册一个 `UserPromptSubmit` hook，并返回 `{"continue": true}`；同时它也可以通过环境变量注入 `SessionStart` reminder 规则：

- `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` 会自动为 Claude Code 启用两条关于使用 `question` 工具的提醒。你也可以把同样的提醒手动写进 `CLAUDE.md`；见 [CLAUDE.md 或 AGENTS.md 推荐内容](#claudemd-or-agentsmd-recommended-content)。
- `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` 会启用关于避免在 agent hooks 中使用 `run_in_background: true` 的提醒。

#### Opencode 插件

subagent marker 生成器被打包为一个 opencode 插件，位于 `.opencode/plugins/subagent-marker.js`。

**安装方式：**

将插件文件复制到你的 opencode 插件目录：

```sh
# 克隆或下载本仓库后复制该插件
cp .opencode/plugins/subagent-marker.js ~/.config/opencode/plugins/
```

或者手动在 `~/.config/opencode/plugins/subagent-marker.js` 创建该文件，并填入插件内容。

**功能：**

- 跟踪 subagent 创建的子会话
- 自动在 subagent 聊天消息前添加 marker system reminder（`__SUBAGENT_MARKER__...`）
- 设置 `x-session-id` 请求头以跟踪会话
- 让该代理能够把来自 subagent 的请求识别为 `x-initiator: agent`

该插件会挂接到 `session.created`、`session.deleted`、`chat.message` 和 `chat.headers` 事件上，以无缝提供 subagent marker 能力。

## 从源码运行

本项目可以通过多种方式从源码运行：

### 开发模式

```sh
bun run dev start
```

### 生产模式

```sh
bun run start start
```

## 使用建议

- 为避免触发 GitHub Copilot 的速率限制，可以使用以下参数：
  - `--manual`：为每个请求启用手动审批，让你完全控制何时发送请求。
  - `--rate-limit <seconds>`：强制请求之间至少保持一定秒数的间隔。例如 `copilot-api start --rate-limit 30` 会确保两次请求之间至少间隔 30 秒。
  - `--wait`：与 `--rate-limit` 配合使用。在命中速率限制时，服务会等待冷却结束，而不是直接返回错误。对于不会自动重试的客户端，这会很有帮助。
- 如果你使用的是 GitHub Business 或 Enterprise 版 Copilot 账号，请使用 `--account-type` 参数（例如 `--account-type business`）。详见 [官方文档](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization)。
- **多账号请求路由：** 使用 `auth add` 添加多个 GitHub Copilot 账号。
  - **Premium 模型：** 会按添加顺序依次尝试账号。当某个账号的 premium request 配额（`remaining=0`）耗尽，或对当前模型来说不足时，代理会自动切换到下一个可用账号。
  - **免费模型：** 当 `accountAffinity=true` 时，拥有相同 affinity key 和 model 的请求会粘在上次成功处理它的账号上。亲和性未命中时，会回退到第一个可用账号。若在 `config.json` 中将 `accountAffinity=false`，则所有请求都改为顺序路由。
  - **模型分类：** 依据 Copilot 模型元数据中的 `billing.is_premium` / `billing.multiplier` 进行判断。缺失 billing 信息或 `billing.is_premium !== true` 的模型，会被视为免费模型。
