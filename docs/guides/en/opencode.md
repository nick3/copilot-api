# OpenCode

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/opencode.md)

## Using with OpenCode

OpenCode already has a direct GitHub Copilot provider. Use this section when you want OpenCode to point at this AI gateway through `@ai-sdk/anthropic` and reuse the [plugin integrations](integrations.md#plugin-integrations).

### Minimal setup

Start the AI gateway with the OpenCode OAuth app:

```sh
npx @nick3/copilot-api@latest auth --oauth-app=opencode
npx @nick3/copilot-api@latest start
```

Then point OpenCode at the gateway with `@ai-sdk/anthropic`.

Example `~/.config/opencode/opencode.json`:

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

Why these fields matter:

- `npm: "@ai-sdk/anthropic"` is the important part. OpenCode will speak Anthropic Messages semantics to this AI gateway instead of flattening everything into OpenAI Chat Completions.
- `options.baseURL` should be `http://localhost:4141/v1`; the Anthropic SDK will append `/messages`, `/models`, and `/messages/count_tokens` automatically.
- If you enable `auth.apiKeys` in this AI gateway, replace `dummy` with a real key. Otherwise any placeholder value is fine.
