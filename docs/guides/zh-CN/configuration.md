# 配置说明

配置文件位于 `$COPILOT_API_HOME/config.json`，默认是 `~/.local/share/copilot-api/config.json`。已有配置项见[项目首页](../../../README.zh-CN.md)。本次新增配置示例：

```json
{
  "smallModels": {"copilot": "gpt-6-luna", "codex": "gpt-6-luna"},
  "providers": {
    "github-copilot": {"enabled": true, "codexModels": ["claude-opus-5.5"]},
    "example": {
      "type": "openai-compatible",
      "baseUrl": "https://provider.example/v1",
      "apiKey": "YOUR_PROVIDER_KEY",
      "modelsDevProviderId": "openai"
    }
  },
  "modelAliases": {"copilot/claude-opus-5.5": {"target": "claude-opus-5.5", "allowOriginal": false}}
}
```

模型名仅作示例，请以账号实际可用模型为准。

- `providers.github-copilot.enabled` 控制整个 Copilot 账号池，账号自己的启停状态保持独立。关闭后保留凭据，暂停刷新并拒绝新的 Copilot 请求，不影响其他提供商或 Admin UI。
- `codexModels` 只影响 Codex 客户端的模型目录。省略表示自动选择，`[]` 表示全部隐藏，非空数组填写上游模型 ID。单模型的 `models.<id>.codex.enabled: false` 仍优先。普通 API 调用权限不变。
- `modelsDevProviderId` 用于关联 models.dev 缓存中的协议、能力与价格。显式模型价格和鉴权设置优先。首次目录下载失败不会阻止网关与 Admin UI 启动。
- `smallModels` 按提供商选择小模型。未配置 `smallModels.copilot` 时兼容旧的 `smallModel`；显式空值关闭可选的任务标题覆盖。Copilot 的预热/压缩仍保留小模型回退行为。
- 全新配置包含 Codex 自动审核与 reserve 映射；已有显式 `modelMappings` 不被覆盖，也可以清空。
- Anthropic 一小时缓存只转发客户端显式请求且在白名单中的 beta，不自动添加一小时 TTL。

以上字段可以在 Admin UI 编辑。保存后应用到运行时；重新加载也可应用外部修改的配置文件。保存与生效状态见[API 说明](api.md)。
