# Docker

使用仓库中的 `docker-compose.yaml` 和[项目首页的 Docker 说明](../../../README.zh-CN.md)。沿用本分支的镜像、多账号注册表、token 目录、数据库及数据目录初始化逻辑。

本次不改变容器数据路径，也不迁移生产数据。重新构建或更新镜像后，在 `/admin` 确认账号仍完整保留。Copilot 总开关仅暂停账号池，不删除持久化状态。远程管理使用 `ADMIN_TOKEN`，与客户端 API 密钥分开配置。
