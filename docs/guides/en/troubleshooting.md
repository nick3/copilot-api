# Troubleshooting

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/troubleshooting.md)

<a id="troubleshooting"></a>

## Troubleshooting

**GitHub Copilot encrypted output decryption failure**

When the GitHub Copilot provider returns or logs `Encrypted function output content could not be decrypted or decoded`, it is usually an upstream issue. Set `useResponsesApiWebSocket` to `false` in `config.json` so Copilot Responses traffic goes over HTTP `/responses` instead:

```json
{
  "useResponsesApiWebSocket": false
}
```

Restart the server after changing the config. See [Configuration (config.json)](configuration.md#configuration-configjson) for the full option reference.

**Claude models missing from the GitHub Copilot model list**

GitHub Copilot can return a different model list depending on the network location the gateway connects from. If your Copilot account has Claude models enabled but `/v1/models` lists no `claude-*` models and requests for them fail (for example with `model_not_supported`), route the gateway's upstream traffic through your proxy and restart it:

```sh
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npx @nick3/copilot-api@latest start --proxy-env
```

Replace the address with your proxy. The gateway caches the model list at startup and refreshes it about every 30 minutes; after the list changes, [regenerate the Codex model catalog](codex.md#generate-model_catalogjson).
