# Claude Code 接入指导文档 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 编写一份完整的 Claude Code 接入指导文档，让研发人员能在 10 分钟内完成配置

**Architecture:** 单文件 Markdown 文档，9 个章节线性叙述，飞书文档友好格式

**Tech Stack:** Markdown

---

### Task 1: 创建文档骨架（概述 + 架构图 + 前置准备）

**Files:**
- Create: `docs/claude-code-onboarding-guide.md`

- [ ] **Step 1: 创建文档文件，写入标题和概述章节**

```markdown
# Claude Code 接入指南

通过 GitHub Copilot 使用 AI 模型（Claude、GPT 等）

---

## 概述

公司已部署 copilot-api 代理服务，将 GitHub Copilot 提供的多种 AI 模型统一暴露为 Anthropic 兼容 API，并接入 new-api 作为统一的 API 网关。

**你只需要做两件事：**
1. 安装并配置 Claude Code，指向 new-api
2. 安装 copilot-api Plugin

**整体架构：**

> Claude Code → new-api（API 网关） → copilot-api（代理层） → GitHub Copilot API

---

## 前置准备

### 1. 安装 Claude Code

如果你已经安装了 Claude Code，可以跳过这一步。

**安装命令：**

​```bash
npm install -g @anthropic-ai/claude-code
​```

**验证安装：**

​```bash
claude --version
​```

> 如果遇到权限问题，macOS/Linux 用户可使用 `sudo npm install -g @anthropic-ai/claude-code`

> 官方文档：https://docs.anthropic.com/en/docs/claude-code/overview

### 2. 获取 API Key

前往飞书文档获取 API 地址和 API Key：

👉 [飞书文档 - API 接入信息](https://tthdtech.feishu.cn/wiki/JK2ZwzURoiehJEk9Njbc2d6nnVe)

请记下以下信息，后续配置需要用到：
- **API 地址**（ANTHROPIC_BASE_URL）
- **API Key**（ANTHROPIC_AUTH_TOKEN）

### 3. 安装 cc-switch（推荐）

cc-switch 是一款桌面 GUI 工具，可以方便地管理 Claude Code 的多套配置（Provider），一键切换。

**安装方式：**

| 平台 | 安装命令 |
|------|---------|
| macOS | `brew tap farion1231/ccswitch && brew install --cask cc-switch` |
| Windows | 下载 `.msi` 安装包 |
| Arch Linux | `paru -S cc-switch-bin` |
| 其他 Linux | 下载 `.deb` / `.rpm` / `.AppImage` |

> 下载地址：https://github.com/farion1231/cc-switch/releases

> 如果你不方便安装 cc-switch，可以跳到「手动配置」章节。
```

- [ ] **Step 2: 确认文件已正确创建**

Run: `head -5 docs/claude-code-onboarding-guide.md`
Expected: 显示文档标题和副标题

---

### Task 2: 编写快速配置章节（cc-switch 方式）

**Files:**
- Modify: `docs/claude-code-onboarding-guide.md`

- [ ] **Step 1: 追加快速配置章节**

在文档末尾追加以下内容：

```markdown
---

## 快速配置（cc-switch 方式 — 推荐）

### Step 1: 添加 Provider

1. 打开 cc-switch 应用
2. 点击「Add Provider」或「添加 Provider」
3. 选择「Custom」自定义配置
4. 填写以下信息：

**核心配置（必填）：**

| 环境变量 | 值 | 说明 |
|---------|---|------|
| `ANTHROPIC_BASE_URL` | 从飞书文档获取的 API 地址 | API 网关地址 |
| `ANTHROPIC_AUTH_TOKEN` | 从飞书文档获取的 Key | API 认证密钥 |
| `ANTHROPIC_MODEL` | `copilot/gpt-5.4` | 主模型 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `copilot/gpt-5.4` | Sonnet 级模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `copilot/claude-opus-4-6` | Opus 级模型 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `qwen3.6-plus` | 小模型（快速任务） |
| `ANTHROPIC_REASONING_MODEL` | `copilot/claude-opus-4-6` | 推理模型 |

**推荐配置（可选）：**

| 环境变量 | 值 | 说明 |
|---------|---|------|
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS` | `1` | 减少非必要的模型调用，节省额度 |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | `1` | 禁用 1M 上下文窗口，减少 token 消耗 |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `0` | 禁用归因头 |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | `false` | 禁用提示建议 |
| `DISABLE_TELEMETRY` | `1` | 禁用遥测数据 |
| `DISABLE_ERROR_REPORTING` | `1` | 禁用错误上报 |
| `DISABLE_BUG_COMMAND` | `1` | 禁用 bug 上报命令 |
| `CLAUDE_CODE_NO_FLICKER` | `1` | 减少界面闪烁 |

### Step 2: 启用 Provider

1. 在 cc-switch 主界面选择刚创建的 Provider
2. 点击「Enable」或在系统托盘中切换
3. **重新打开终端**（Claude Code 会自动读取新配置，无需重启 Claude Code 本身）

### Step 3: 验证

​```bash
claude
​```

输入以下测试 prompt 验证配置是否生效：

> Hello, 请告诉我你是哪个模型

如果返回了模型信息，说明配置成功。
```

---

### Task 3: 编写手动配置章节

**Files:**
- Modify: `docs/claude-code-onboarding-guide.md`

- [ ] **Step 1: 追加手动配置章节**

```markdown
---

## 手动配置（备选方案）

如果你无法安装 cc-switch，或需要更精细地控制配置，可以直接编辑 Claude Code 的配置文件。

### 配置文件位置

​```
~/.claude/settings.json
​```

### 参考配置

将以下内容写入 `~/.claude/settings.json`（请替换 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 为实际值）：

​```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-你的API Key",
    "ANTHROPIC_BASE_URL": "你的API地址",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen3.6-plus",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "copilot/claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "copilot/gpt-5.4",
    "ANTHROPIC_MODEL": "copilot/gpt-5.4",
    "ANTHROPIC_REASONING_MODEL": "copilot/claude-opus-4-6",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_1M_CONTEXT": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_NO_FLICKER": "1",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_BUG_COMMAND": "1"
  },
  "enabledPlugins": {
    "claude-plugin@copilot-api-marketplace": true
  },
  "extraKnownMarketplaces": {
    "copilot-api-marketplace": {
      "source": {
        "source": "git",
        "url": "https://github.com/nick3/copilot-api.git"
      }
    }
  },
  "permissions": {
    "allow": [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "Agent"
    ],
    "defaultMode": "default",
    "deny": []
  },
  "language": "Chinese"
}
​```

> 此配置与 cc-switch Provider 等价。如果你同时使用 cc-switch，cc-switch 的配置会覆盖此文件。

### 字段说明

| 字段 | 说明 |
|------|------|
| `env` | 环境变量配置，包含 API 地址、Key、模型等核心参数 |
| `enabledPlugins` | 启用的 Plugin 列表 |
| `extraKnownMarketplaces` | 自定义 Plugin 来源仓库 |
| `permissions` | Claude Code 的工具权限设置 |
| `language` | 界面和回复语言 |
```

---

### Task 4: 编写 Plugin 安装章节

**Files:**
- Modify: `docs/claude-code-onboarding-guide.md`

- [ ] **Step 1: 追加 Plugin 安装章节**

```markdown
---

## 安装 copilot-api Plugin

### Plugin 的作用

copilot-api Plugin 是一个 Claude Code 插件，通过 hooks 机制为你的工作流提供以下增强：

1. **节省高级请求额度（核心功能）**
   Plugin 将子 agent（subagent）请求标记为 subagent 创建，使上游 GitHub Copilot 账号**不额外消耗高级请求（Premium Request）额度**。如果你频繁使用多 agent 协作（如 brainstorming、code-review 等），这可以显著节省配额。

2. **会话级账号亲和性**
   通过注入会话标记，copilot-api 可以将同一会话的所有请求路由到同一 GitHub 账号，避免因账号切换导致的上下文不一致。

3. **交互规则优化**（可选）
   开启 `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` 后，强制 Claude Code 使用结构化提问工具，提升交互体验。

4. **代理延迟保护**（可选）
   开启 `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` 后，阻止后台 agent 运行，避免代理延迟导致的 "No task found" 错误。

### 安装步骤

在 `~/.claude/settings.json` 中添加以下配置：

**1. 添加 Plugin 来源（extraKnownMarketplaces）：**

​```json
{
  "extraKnownMarketplaces": {
    "copilot-api-marketplace": {
      "source": {
        "source": "git",
        "url": "https://github.com/nick3/copilot-api.git"
      }
    }
  }
}
​```

**2. 启用 Plugin（enabledPlugins）：**

​```json
{
  "enabledPlugins": {
    "claude-plugin@copilot-api-marketplace": true
  }
}
​```

**3. 重启 Claude Code 生效**

> 如果你使用了「手动配置」章节的完整 JSON，Plugin 配置已包含在内，无需重复添加。

### 验证 Plugin 安装

启动 Claude Code 后，如果 Plugin 加载成功，你会在 session 启动时看到相关的 hook 注入提示。
```

---

### Task 5: 编写模型选择指南章节

**Files:**
- Modify: `docs/claude-code-onboarding-guide.md`

- [ ] **Step 1: 追加模型选择指南章节**

```markdown
---

## 模型选择指南

### 可用模型

以 `copilot/` 开头的模型 ID 来自 GitHub Copilot：

| 模型 ID | 定位 | 适用场景 |
|---------|------|---------|
| `copilot/claude-opus-4-6` | 最强推理能力 | 架构设计、复杂分析、创意探索 |
| `copilot/claude-sonnet-4-6` | 均衡性能 | 通用任务 |
| `copilot/gpt-5.4` | 高效执行 | 写代码、改 bug、明确任务执行 |
| `copilot/gpt-5.4-mini` | 轻量快速 | 简单查询、代码理解 |
| `copilot/gpt-5-mini` | 轻量快速 | 简单查询 |
| `qwen3.6-plus` | 轻量快速，成本低 | 简单任务、代码理解 |

### 推荐搭配策略

| 任务类型 | 推荐模型 | 示例 |
|---------|---------|------|
| **明确的执行任务** | `copilot/gpt-5.4` | 写代码、改 bug、重构、执行计划 |
| **需要讨论的复杂任务** | `copilot/claude-opus-4-6` | 架构设计、方案探讨、创意探索 |
| **简单快速任务** | `copilot/gpt-5.4-mini` 或 `qwen3.6-plus` | 理解代码、快速查询、阅读文档 |

### 在对话中切换模型

在 Claude Code 对话中，可以使用 `/model` 命令随时切换模型：

​```
/model copilot/claude-opus-4-6
​```
```

---

### Task 6: 编写使用技巧章节

**Files:**
- Modify: `docs/claude-code-onboarding-guide.md`

- [ ] **Step 1: 追加使用技巧章节**

```markdown
---

## 使用技巧

### 推荐安装的 Plugin

除了 copilot-api Plugin 外，以下 Plugin 可以显著提升工作效率：

| Plugin | 说明 |
|--------|------|
| `superpowers@claude-plugins-official` | 增强的 brainstorming、planning、TDD 等工作流 |
| `code-review@claude-plugins-official` | 代码审查 |
| `code-simplifier@claude-plugins-official` | 代码简化和优化 |
| `commit-commands@claude-plugins-official` | Git 提交工作流 |
| `pr-review-toolkit@claude-plugins-official` | PR 审查工具集 |
| `typescript-lsp@claude-plugins-official` | TypeScript 语言服务（LSP 支持） |

在 `settings.json` 的 `enabledPlugins` 中添加对应项即可启用。

### 性能优化建议

| 环境变量 | 作用 |
|---------|------|
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS=1` | 减少非必要的模型调用，节省配额 |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | 禁用 1M 上下文窗口，减少单次请求的 token 消耗 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90` | 上下文使用达到 90% 时自动压缩，避免上下文溢出 |
| `BASH_MAX_TIMEOUT_MS=600000` | 将命令超时设为 10 分钟，适合长时间运行的构建任务 |

### cc-switch 的 Provider 切换

如果你配置了多个 Provider（如不同的 API 地址或模型组合），可以通过以下方式快速切换：

1. **系统托盘**: 右键 cc-switch 托盘图标，选择目标 Provider
2. **主界面**: 打开 cc-switch，选择 Provider 后点击「Enable」

切换后重新打开终端即可生效。
```

---

### Task 7: 编写 FAQ 章节

**Files:**
- Modify: `docs/claude-code-onboarding-guide.md`

- [ ] **Step 1: 追加 FAQ 章节**

```markdown
---

## 常见问题（FAQ）

### Q: 报错 "authentication failed" 或 "401"

**可能原因：**
- API Key 不正确或已过期
- `ANTHROPIC_AUTH_TOKEN` 格式错误（应以 `sk-` 开头）

**解决方案：**
1. 检查 `ANTHROPIC_AUTH_TOKEN` 是否正确
2. 前往飞书文档确认 Key 是否有效
3. 确认 `ANTHROPIC_BASE_URL` 地址正确

---

### Q: 模型响应很慢

**可能原因：**
- 网络到 API 网关的延迟较高
- 使用了较重的模型处理简单任务

**解决方案：**
1. 检查网络连通性：`curl -I $ANTHROPIC_BASE_URL`
2. 对于简单任务，切换到 `copilot/gpt-5.4-mini` 或 `qwen3.6-plus`
3. 开启 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 减少 token 传输量

---

### Q: 提示 "model not found"

**可能原因：**
- 模型 ID 拼写错误
- 缺少 `copilot/` 前缀

**解决方案：**
确认模型 ID 格式正确，Copilot 模型必须包含 `copilot/` 前缀，例如：
- ✅ `copilot/gpt-5.4`
- ❌ `gpt-5.4`

---

### Q: Plugin 未生效

**可能原因：**
- `extraKnownMarketplaces` 配置不正确
- Plugin 未在 `enabledPlugins` 中启用
- Claude Code 未重启

**解决方案：**
1. 检查 `~/.claude/settings.json` 中的配置是否正确
2. 确认 `enabledPlugins` 中有 `"claude-plugin@copilot-api-marketplace": true`
3. 完全退出并重新启动 Claude Code

---

### Q: 如何查看当前使用的是哪个模型？

在 Claude Code 对话中输入：

​```
/model
​```

会显示当前配置的模型信息。

---

### Q: cc-switch 切换后配置没有生效

**解决方案：**
1. 切换 Provider 后需要**重新打开终端**
2. 确认 cc-switch 显示目标 Provider 状态为「Active」
3. 在新终端中运行 `claude` 确认

---

### Q: 如何同时在不同项目使用不同模型？

可以在项目根目录创建 `.claude/settings.json`，其中的配置会覆盖全局配置。这样不同项目可以使用不同的模型组合。
```

---

### Task 8: 最终审阅和格式检查

**Files:**
- Modify: `docs/claude-code-onboarding-guide.md`

- [ ] **Step 1: 通读全文，检查以下项目**

1. 所有链接是否正确（飞书文档、cc-switch GitHub、Claude Code 官方文档）
2. JSON 示例中的占位符是否清晰标注
3. 环境变量名称前后是否一致
4. 章节顺序是否符合线性叙述逻辑
5. 飞书 Markdown 兼容性（不使用飞书不支持的 Markdown 语法）

- [ ] **Step 2: 确认文档完整性**

对照设计文档 `docs/superpowers/specs/2026-04-10-claude-code-onboarding-guide-design.md` 检查：
- 所有 9 个章节是否都已覆盖
- 模型列表是否完整
- FAQ 是否覆盖了设计中的所有预设问题
