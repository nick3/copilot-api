# 安装与启动

本分支提供多账号网关与浏览器 Admin UI。安装、Docker 数据目录和命令行参数以[项目首页](../../../README.zh-CN.md)为准。

在仓库根目录运行：

```sh
bun install --frozen-lockfile
bun install --frozen-lockfile --cwd admin-ui
bun run build
bun run start start
```

CLI 包名为 `@nick3/copilot-api`，包要求 Node.js >= 22.18.0，也可用 Bun 运行源码。账号列表为空时服务仍可启动，打开 `/admin` 添加 Copilot 账号。第三方提供商和 Codex 可独立配置。

提供商开关与热更新见[配置说明](configuration.md)，网络访问认证见[API 说明](api.md)。
