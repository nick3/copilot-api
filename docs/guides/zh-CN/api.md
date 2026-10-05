# API 与认证

客户端端点包括 `/v1/messages`、`/v1/messages/count_tokens`、`/v1/responses`、`/v1/chat/completions`、`/v1/embeddings` 和 `/v1/models`。已配置的第三方提供商可通过提供商路径或 `provider/model` 名称访问。Copilot 的显式模型别名（包括 `copilot/claude-opus-5.5` 这样的名称）会在账号选择前解析。

客户端使用 `auth.apiKeys`，通过 `x-api-key` 或 `Authorization: Bearer` 认证。现有旧密钥回退机制仍保留；通过 Admin UI 或 CLI 清空密钥时，会显式禁止旧环境密钥恢复生效。监听地址与客户端设置见[项目首页](../../../README.zh-CN.md)。

Admin UI 位于 `/admin`，管理 API 位于 `/api/admin/*`。沿用本分支的 localhost / 同源访问规则。远程管理需设置 `ADMIN_TOKEN`，通过 `x-admin-token` 或 `Authorization: Bearer` 传入。本分支不生成 `auth.adminApiKey`。

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/config` | 读取配置 |
| `POST /api/admin/config` | 校验、保存并应用配置补丁 |
| `POST /api/admin/config/reload` | 从文件重新读取并应用到运行中的服务 |

保存响应包含 `_runtimeApplied`。若为 false，表示文件已保存但运行时应用失败，可以点击重新加载重试。重载遇到无效 JSON 会保留上次有效配置。请求记录、账号状态、配额统计和重放继续使用现有管理接口。
