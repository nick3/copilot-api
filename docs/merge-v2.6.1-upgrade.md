# all 分支合入 caozhiyuan v2.6.1 后的升级说明

本次保留多 GitHub Copilot 账号调度、Admin UI、请求捕获/回放和现有模型别名。合入上游公共 API、传输、Codex 凭据、Provider、统计和持久化改进；不包含 Electron、桌面更新或旧 usage-viewer。功能取舍见 [合并分析](2026-09-16-caozhiyuan-v2.6.1-merge-analysis.md)。

## 启动与网关密钥

CLI 默认监听 `127.0.0.1`，`start --host <地址>` 优先于 `HOST`。监听非回环地址必须配置网关 API key，HTTP 和 Responses WebSocket 均检查鉴权。对外监听时 CORS 只允许与请求 URL 相同的 origin；显式启用的 MCP 路由保留原有契约。

```sh
bun run src/main.ts auth keys --add '<gateway-key>'
bun run src/main.ts auth keys --list
bun run src/main.ts start --host 0.0.0.0
```

`auth keys --remove '<key>'` 删除指定密钥，`auth keys --clear` 清空密钥。清空后持久化 `auth.allowLegacyApiKeyFallback=false`，即使重启后仍存在 `COPILOT_API_KEY`，也不会无提示恢复旧密钥。旧部署未显式关闭兼容回退时，仍可使用 `COPILOT_API_KEY` 或 `config.apiKey`。Admin 中清空密钥也关闭兼容回退。

`ADMIN_TOKEN` 仍是独立的管理面凭据，与网关 API key、GitHub token、Codex 凭据分开。返回上游 token 的 `/token` 端点已删除。`COPILOT_API_GITHUB_TOKEN` 可作为临时高优先级 Copilot 账号传入；`--github-token` 优先，已有注册账号不受覆盖。

## 容器

镜像运行于 `bun` 非 root 用户，API 数据目录为 `/data`。使用仓库附带的 Compose 文件构建当前 all 分支：

```sh
mkdir -p copilot-data
docker compose build
docker compose run --rm data-init
docker compose run --rm --no-deps copilot-api auth keys --add '<gateway-key>'
docker compose run --rm --no-deps copilot-api auth add
# 远程访问 Admin 前，在环境或 .env 中配置 ADMIN_TOKEN。
docker compose up -d
```

Compose 默认只发布宿主机 `127.0.0.1:4141`，容器内部显式监听 `0.0.0.0`。需要网络访问时设置 `COPILOT_API_BIND`，例如 `0.0.0.0`，并配置独立的 `ADMIN_TOKEN`。镜像默认名称为 `copilot-api:local`，可用 `COPILOT_API_IMAGE` 指定自己构建的标签。

迁移旧容器时，将原持久化数据目录挂载到 `/data`，保留整个目录并先备份。初始化只修复列出的网关状态路径权限，包括 `tokens/`、账号注册表、配置、Codex 凭据、模型、日志、缓存、用量数据库和 `admin.sqlite`。不会递归修改任意挂载目录的全部文件。

`COPILOT_API_SQLITE_DB_PATH` 仅控制用量数据库，不改变 Admin 数据库的位置。若指向自定义目录，需另行保证该目录可写和持久化。`/tmp` 默认 512 MiB，可用 `COPILOT_API_TMP_SIZE` 调整；图片单请求总限额为 128 MiB，并发上传仍共享临时磁盘预算。

## 新配置

Admin 设置页支持以下字段并保留原有 `providers.*.models.*.codex` 格式：

- `providers.*.authType = "azure-entra"`：使用服务进程环境中的 Azure DefaultAzureCredential 获取令牌，无需将令牌填入 API key。
- `providers.*.models.*.reasoningField`：`reasoning` 或 `reasoning_content`，用于兼容模型的历史推理消息。
- 模型 `pricing.offPeak` 和 `pricing.peakWindows`：通过现有价格 JSON 编辑器设置。窗口使用 UTC 分钟和 ISO 星期（周一为 1、周日为 7），价格按事件发生时间固化，不回算已有账目。
- `upstreamTransport`：高级设置中的 JSON 编辑器，可只覆盖部分字段。

```json
{
  "upstreamTransport": {
    "headersTimeoutMs": 300000,
    "streamInactivityTimeoutMs": 300000,
    "websocketOpenTimeoutMs": 30000,
    "websocketPoolIdleTimeoutMs": 60000,
    "websocketMaxBufferedBytes": 8388608,
    "websocketMaxBufferedMessages": 1024
  }
}
```

超时不等于整次生成的总时长限制。发送前已取消的请求不会提交到上游；发送后下游断开，网关继续读取至结束或超时，以完成用量结算。原有 Copilot 账号/会话/子代理隔离和 WebSocket bridge 失效通知保留。配置损坏或不可读时会报错，避免用默认值覆盖原文件。

Reasoning effort 继续采用 all 的显式意图和模型默认值优先级，显式 `null` 禁用回退；不支持的档位选择最近档位，同距取低。新增 `ultra` 到 `max` 的兼容。搜索默认降低上下文和 reasoning 开销，但保留用户显式配置的优先级。

## Codex 与统计

Codex 可保存最多 3 个账号，保持一个活动账号，不参与 Copilot 账号池调度：

```sh
bun run src/main.ts auth login --provider codex --alias work
bun run src/main.ts auth codex --list
bun run src/main.ts auth codex --use work
bun run src/main.ts auth codex --remove unused
```

选择保存在 `providers.codex.accountId`，Admin 保存其他配置时会保留。CLI 切换后重启服务以使用新账号；Codex 可视化账号管理仍留作独立后续功能。原子持久化、文件锁和进程内刷新合并不等同于多个进程之间的 OAuth 刷新去重。

Admin 和 `/token-usage` 同步提供今日、本周、近 7 天、本月、近 30 天及全部记录。参数依次为 `today`、`this_week`、`last_7_days`、`this_month`、`last_30_days`、`lifetime`。旧 `day/week/month` 参数仍映射为今日/近 7 天/近 30 天，避免改变旧调用的统计范围。“全部”指数据库现存记录。

MCP 无参数 stdio 启动使用快路径；带 `--transport http`、host/port/path 或前置全局选项时继续走完整 CLI。源码构建需要 Node 22.18 以上，CI/Docker 使用 Node 24；网关继续运行于 Bun，测试使用 Bun 1.3.14 以上以支持 `--isolate`。
