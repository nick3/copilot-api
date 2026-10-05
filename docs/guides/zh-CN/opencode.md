# OpenCode

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/opencode.md)

<a id="using-with-opencode"></a>

## 与 OpenCode 一起使用

OpenCode 已经有直接的 GitHub Copilot provider。本节适用于你希望让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个 AI gateway，并使用[插件集成](integrations.md#plugin-integrations)提供的 agent 行为时。

### 最小配置

使用 OpenCode OAuth app 启动 AI gateway：

```sh
npx @nick3/copilot-api@latest auth --oauth-app=opencode
npx @nick3/copilot-api@latest start
```

然后让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个 AI gateway。

示例 `~/.config/opencode/opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/anthropic",
      "name": "My Local",
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
            "context": 400000,
            "input": 272000,
            "output": 128000
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
            "context": 200000,
            "output": 32000
          },
          "options": {
            "thinking": {
              "type": "adaptive"
            },
            "effort": "max"
          }
        }
      }
    }
  }
}
```

这些字段的重要性：

- `npm: "@ai-sdk/anthropic"` 是关键。OpenCode 会以 Anthropic Messages 语义与这个 AI gateway 通信，而不是把一切扁平化为 OpenAI Chat Completions。
- `options.baseURL` 应设为 `http://localhost:4141/v1`；Anthropic SDK 会自动补上 `/messages`、`/models` 和 `/messages/count_tokens`。
- 如果你在此代理中启用了 `auth.apiKeys`，请把 `dummy` 替换为真实 key；否则任意占位值都可以。
