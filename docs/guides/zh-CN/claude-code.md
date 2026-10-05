# Claude Code

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/claude-code.md)

<a id="using-with-claude-code"></a>

## 与 Claude Code 一起使用

这个 AI gateway 可以为 [Claude Code](https://docs.anthropic.com/en/claude-code) 提供后端能力。Claude Code 是 Anthropic 提供的实验性面向开发者的对话式 AI 助手。

有两种方式可以把 Claude Code 配置为使用这个 AI gateway：

### 通过 `--claude-code` 标志进行交互式配置

执行带 `--claude-code` 的 `start` 命令开始：

```sh
npx @nick3/copilot-api@latest start --claude-code
```

你不再需要手动选择模型。Gateway 会自动检测每个 Claude Code 尺寸档位对应的最新可用模型——opus 映射到最新的 Opus 模型，sonnet 映射到最新的 Sonnet 模型，haiku 映射到最新的 Haiku 模型——并生成相应设置 `ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 的命令。若某个档位没有匹配的可用模型，则会被省略。该命令会被复制到剪贴板，并设置 Claude Code 使用这个 AI gateway 所需的环境变量。

在新的终端中粘贴并执行这条命令，即可启动 Claude Code。

<a id="manual-configuration-with-settingsjson"></a>

### 通过 `settings.json` 手动配置

另一种方式是在项目根目录中创建 `.claude/settings.json` 文件，并写入 Claude Code 所需的环境变量。这样你就不需要每次都运行交互式配置了。

下面是一个 `.claude/settings.json` 示例：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-5.6-sol",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.6-sol",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.6-sol",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5.6-luna",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "272000",
    "CLAUDE_CODE_USE_VERTEX": "0",
    "CLAUDE_CODE_USE_BEDROCK": "0",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
    "CLAUDE_CODE_TOTAL_TOKENS_REMINDER": "off",
    "CLAUDE_CODE_EFFORT_LEVEL": "max",
    "MCP_CONNECT_TIMEOUT_MS": "20000"
  },
  "alwaysThinkingEnabled": true,
  "showThinkingSummaries": true
}
```

- 请根据需要替换 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。配置完成后，请安装 claude code 插件，见 [插件集成](integrations.md#plugin-integrations)。
- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off"` 用于关闭 Claude Code 的 total tokens 提醒功能。该功能开启时会在对话中注入 `<total_tokens>N tokens left</total_tokens>` 块，提示模型剩余的 token 预算；默认预算为 1500w（15,000,000）tokens，意义不大，因此这里配置为关闭。
- 如果你使用的是 codex provider，建议**不要**将模型名配置成 `codex/xxx` 格式（如 `codex/gpt-5.6-sol`）。Claude Code 会针对 `codex/` 前缀做降智行为——例如每次请求时移除所有之前返回的思考块（thinking blocks）。请使用纯模型名（如 `gpt-5.6-sol`），并在 `config.json` 中配置 `modelMappings` 将其映射回 codex provider：
  ```json
  "modelMappings": {
    "gpt-5.6-sol": "codex/gpt-5.6-sol",
    "gpt-5.6-terra": "codex/gpt-5.6-terra",
    "gpt-5.6-luna": "codex/gpt-5.6-luna"
  },
  ```
- 将 `CLAUDE_CODE_ATTRIBUTION_HEADER` 设为 `0` 可以阻止 Claude Code 在 system prompt 中附加计费和版本信息，从而避免 prompt cache 失效。
- 关闭 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` 和 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` 可以避免不必要地消耗额度。
- Claude Code WebSearch 已支持纯搜索请求。Copilot 路径请保持全局 `messageApiWebSearchModel` 指向 Responses-capable GPT 模型或 `provider/model` 别名；provider 路由请使用原生 Anthropic provider 或 `openai-responses` provider。只有在你明确想禁止这类流量时，才需要把 `WebSearch` 加到 `permissions.deny`。
- 如果使用的不是 Claude 模型，请不要启用 `ENABLE_TOOL_SEARCH`。如果使用的是 Claude 模型，则可以启用 `ENABLE_TOOL_SEARCH`。当前 Claude Code 使用的是客户端 tool search 模式，在该模式下每次加载 defer tools 都需要额外请求一次。
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：设置用于自动压缩计算的上下文容量（以 token 为单位）。默认使用模型自身的上下文窗口：标准模型为 200K，扩展上下文模型为 1M。使用 1M 上下文模型（如 `claude-opus-4-6`）时，可设置一个较低的值（如 `500000`）将窗口视为 500K 用于压缩计算。该值受限于模型的实际上下文窗口上限。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 会基于此值的百分比生效。设置此变量可将压缩阈值与状态栏的 `used_percentage` 解耦（后者始终使用模型的完整上下文窗口）。

- `CLAUDE_CODE_PROMPT_CACHE_TTL`：Claude Code v2.1.242+ 可设为 `1h`，为 Claude 模型请求 1 小时 prompt cache；API key 场景默认使用 5 分钟缓存。网关会将客户端请求的 `extended-cache-ttl-2025-04-11` beta 和内容块上的 `cache_control.ttl` 透传到 Copilot Messages 上游，不会主动添加 1h 配置。GPT 模型不适用此设置。子代理等其他请求可单独设置 `subagentPromptCacheTtl` 或 `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`。完整优先级见 [Claude Code prompt caching 文档](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself)。
  - **风险提示：** [GitHub Copilot 官方价格文档](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)目前未单独列出 cache 1h 的价格。虽然 Copilot models 接口返回了 `cache_write_1h_price`，但该字段不等于官方已公开确认 1h 缓存的计费规则；使用有风险，请谨慎使用，并以上游实际支持情况和计费为准。

更多选项见：[Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

也可以参考 IDE 集成说明：[Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)
