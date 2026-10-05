# 故障排查

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/troubleshooting.md)

<a id="troubleshooting"></a>

## 故障排查

**GitHub Copilot 加密输出解密失败**

使用 GitHub Copilot provider 时，如果响应或日志中出现 `Encrypted function output content could not be decrypted or decoded`，通常是上游问题。把 `config.json` 里的 `useResponsesApiWebSocket` 设为 `false`，让 Copilot Responses 改走 HTTP `/responses` 即可绕过：

```json
{
  "useResponsesApiWebSocket": false
}
```

修改后重启服务生效。完整配置项说明见[配置（config.json）](configuration.md#configuration-configjson)。

**GitHub Copilot 模型列表中缺少 Claude 模型**

GitHub Copilot 返回的模型列表可能因网关所在的网络位置而不同。如果 Copilot 账号已启用 Claude 模型，但 `/v1/models` 中没有任何 `claude-*` 模型，且请求这些模型失败（例如返回 `model_not_supported`），请让网关通过代理访问上游并重启：

```sh
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npx @nick3/copilot-api@latest start --proxy-env
```

请将地址替换为你的代理。网关启动时缓存模型列表，之后约每 30 分钟刷新一次；模型列表变化后，请重新[生成 Codex 模型目录](codex.md#一键生成-model_catalogjson)。
