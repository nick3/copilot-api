# Claude Code 接入指南 — 设计文档

**日期**: 2026-04-10
**类型**: 用户文档设计规格
**目标**: 编写面向公司研发部门的 Claude Code 接入指导文档

---

## 1. 背景与目标

公司已部署 copilot-api 服务，将 GitHub Copilot 提供的多种 AI 模型（Claude、GPT 等）统一暴露为 Anthropic 兼容 API，并接入 new-api 作为 API 网关。研发人员只需将 Claude Code 指向 new-api，配置对应的模型 ID 即可使用。

**文档目标**: 让所有研发人员（不论是否熟悉 Claude Code）能在 10 分钟内完成配置并开始使用。

**架构概览**:

```
Claude Code → new-api（API 网关） → copilot-api（代理层） → GitHub Copilot API
```

## 2. 目标读者

- 混合水平：部分读者熟悉 Claude Code，部分是初次接触
- 需兼顾快速上手和从头引导两种需求

## 3. 文档载体

- 飞书文档友好的 Markdown 格式
- 最终发布到飞书文档供研发团队阅读

## 4. 文档结构（方案 A：快速上手优先）

### 4.1 概述

- 标题: 「Claude Code 接入指南 — 通过 GitHub Copilot 使用 AI 模型」
- 简述公司已部署的架构（Claude Code → new-api → copilot-api → GitHub Copilot API）
- 说明使用前需先获取 API Key，引导至飞书文档

### 4.2 前置准备

**Claude Code 安装**:
- 安装方式: `npm install -g @anthropic-ai/claude-code`
- 附官方文档链接
- 验证安装: `claude --version`

**获取 API Key**:
- 引导读者前往飞书文档获取 API 地址和 Key
- 链接: `https://tthdtech.feishu.cn/wiki/JK2ZwzURoiehJEk9Njbc2d6nnVe`

**cc-switch 安装**:
- 推荐安装 cc-switch 工具（`https://github.com/farion1231/cc-switch`）
- 用于便捷管理 Claude Code 的多套配置

### 4.3 快速配置（cc-switch 方式 — 推荐）

**步骤**:
1. 安装 cc-switch
2. 创建名为 `copilot` 的 profile，包含以下核心环境变量:
   - `ANTHROPIC_BASE_URL`: new-api 地址
   - `ANTHROPIC_AUTH_TOKEN`: 从飞书文档获取的 Key
   - `ANTHROPIC_MODEL`: 主模型（推荐 `copilot/gpt-5.4`）
   - `ANTHROPIC_DEFAULT_SONNET_MODEL`: Sonnet 级模型（`copilot/gpt-5.4`）
   - `ANTHROPIC_DEFAULT_OPUS_MODEL`: Opus 级模型（`copilot/claude-opus-4-6`）
   - `ANTHROPIC_DEFAULT_HAIKU_MODEL`: 小模型（`qwen3.6-plus`）
   - `ANTHROPIC_REASONING_MODEL`: 推理模型（`copilot/claude-opus-4-6`）
3. 其他推荐环境变量（分组说明，非强制）:
   - 节省 token 类: `DISABLE_NON_ESSENTIAL_MODEL_CALLS`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`
   - 禁用遥测类: `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_BUG_COMMAND`
   - 体验优化类: `CLAUDE_CODE_NO_FLICKER`, `CLAUDE_CODE_ATTRIBUTION_HEADER`
4. 切换 profile 启动: `cc-switch copilot`

### 4.4 手动配置（备选方案）

- 适用场景: 无法安装 cc-switch，或需要精细控制
- 编辑 `~/.claude/settings.json`，提供完整 JSON 示例（基于用户提供的参考配置）
- 核心字段说明: `env` 字段中各环境变量的含义
- 指出该 JSON 与 cc-switch profile 等价

**参考配置 JSON 包含**:
- `env`: 所有环境变量配置
- `enabledPlugins`: 推荐的 plugin 组合
- `extraKnownMarketplaces`: copilot-api plugin 的 marketplace 来源
- `permissions`: 推荐的权限设置
- `language`: 设为 "Chinese"

### 4.5 安装 copilot-api Plugin

**Plugin 的作用**:

1. **节省高级请求额度（核心功能）**: Plugin 将用户的子 agent（subagent）请求标记为 subagent 创建，使上游 GitHub Copilot 账号不额外消耗高级请求（Premium Request）额度。对于频繁使用多 agent 协作的场景，这可以显著节省配额。
2. **会话级账号亲和性**: 通过注入 `__SUBAGENT_MARKER__`（含 session_id、agent_id、agent_type），copilot-api 可将同一会话的所有请求路由到同一 GitHub 账号，避免因账号切换导致的上下文不一致。
3. **交互规则优化**（可选）: 开启 `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` 后，强制使用结构化提问工具（AskUserQuestion），提升交互体验。
4. **代理延迟保护**（可选）: 开启 `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` 后，阻止后台 agent 运行，避免代理延迟导致的 "No task found" 错误。

**安装步骤**:
1. 在 `settings.json` 的 `extraKnownMarketplaces` 中添加:
   ```json
   "copilot-api-marketplace": {
     "source": {
       "source": "git",
       "url": "https://github.com/nick3/copilot-api.git"
     }
   }
   ```
2. 在 `enabledPlugins` 中启用:
   ```json
   "claude-plugin@copilot-api-marketplace": true
   ```
3. 重启 Claude Code 生效

**验证安装**: 启动 Claude Code 后观察 session 输出是否包含 plugin 注入的提示。

### 4.6 模型选择指南

**可用模型列表**:

| 模型 ID | 来源 | 定位 |
|---------|------|------|
| `copilot/claude-opus-4-6` | GitHub Copilot | 最强推理，适合架构设计、复杂分析 |
| `copilot/claude-sonnet-4-6` | GitHub Copilot | 均衡性能 |
| `copilot/gpt-5.4` | GitHub Copilot | 高效执行，适合明确任务 |
| `copilot/gpt-5.4-mini` | GitHub Copilot | 轻量快速 |
| `copilot/gpt-5-mini` | GitHub Copilot | 轻量快速 |
| `qwen3.6-plus` | new-api | 轻量快速，成本低 |

**推荐搭配策略**:
- **明确任务**（写代码、改 bug、执行计划）→ `copilot/gpt-5.4`
- **讨论方案**（架构设计、创意探索、复杂分析）→ `copilot/claude-opus-4-6`
- **简单任务**（读代码、快速查询、理解代码）→ `copilot/gpt-5.4-mini` 或 `qwen3.6-plus`

### 4.7 验证配置

- 启动 Claude Code（`claude` 命令），观察是否正常连接
- 输入简单验证 prompt: "Hello, 请告诉我你是哪个模型"
- 确认响应来自预期模型
- 检查 plugin 加载提示

### 4.8 使用技巧

- **模型切换**: 在对话中使用 `/model` 命令切换模型
- **profile 切换**: 用 cc-switch 在不同配置间快速切换
- **推荐 plugin 组合**: 列出 enabledPlugins 中推荐的 plugin 及其用途:
  - `superpowers`: 增强的 brainstorming、planning、TDD 等工作流
  - `code-review`: 代码审查
  - `code-simplifier`: 代码简化
  - `commit-commands`: 提交工作流
  - `pr-review-toolkit`: PR 审查工具
  - `typescript-lsp`: TypeScript 语言服务
  - `codex`: OpenAI Codex 集成
- **性能优化环境变量说明**:
  - `DISABLE_NON_ESSENTIAL_MODEL_CALLS=1`: 减少非必要的模型调用
  - `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`: 禁用 1M 上下文窗口，减少 token 消耗
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90`: 90% 上下文使用时自动压缩

### 4.9 FAQ / 常见问题

预设问题:
- Q: 报错 "authentication failed" → 检查 API Key 是否正确
- Q: 模型响应很慢 → 检查网络连通性，考虑切换更轻量模型
- Q: 提示 "model not found" → 确认模型 ID 是否包含 `copilot/` 前缀
- Q: Plugin 未生效 → 检查 extraKnownMarketplaces 配置、重启 Claude Code
- Q: 如何查看当前使用的模型和账号 → 访问 copilot-api Admin UI
- 预留 3-5 个占位，后续根据实际反馈补充

## 5. 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 文档结构 | 快速上手优先（方案 A） | 线性叙述、飞书友好、新手顺序读/老手跳读 |
| 主要配置方式 | cc-switch 为主 | 简化配置管理，支持多 profile 切换 |
| 备选配置方式 | 手动编辑 settings.json | 兼容无法安装 cc-switch 的场景 |
| 敏感信息处理 | 引导至飞书文档 | API Key、服务地址等集中管理 |
| 模型推荐 | 按任务类型推荐 | 帮助读者快速选择合适模型 |

## 6. 下一步

- 根据本设计文档编写最终的用户指导文档
- 文档写完后发布到飞书文档供研发团队阅读
