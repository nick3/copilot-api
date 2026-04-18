# Developer Mode（Request Replay）

## 1. 功能简介

Developer Mode 是 Admin-UI 中的调试工具，用于对请求历史里返回 4xx 的上游请求进行重放。它适合在排查上游报错时使用：你可以基于系统捕获到的真实出站请求，直接在页面中修改内容后重新发送，而不需要离开管理后台。

核心能力包括：

- 修改请求体（request body）
- 修改业务头（business headers）
- 切换上游账号进行重放
- 查看上游原始响应
- 查看经过本系统 translation 层转换后的响应

Developer Mode 提供两种响应模式：

- **Collect**：等待上游完整返回后，一次性展示完整响应
- **Live**：以 SSE 方式实时展示上游返回的每个 chunk

## 2. 开启方法

### 2.1 通过 Admin-UI 开启

1. 访问 Admin-UI 的 Settings 页面。
2. 找到 **Developer Mode** 区块。
3. 开启 **Enable Developer Mode** 主开关。
4. 开启 **Capture 4xx upstream payloads** 捕获开关。

这两个开关是独立的：

- 你可以只开启捕获，不开启重放
- 你也可以只开启重放，不开启捕获

也就是说，`enabled` 和 `capture4xx` 不互相强绑定，分别控制不同能力。

### 2.2 通过 API 开启

查看当前状态：

```http
GET /api/admin/dev-mode
```

示例响应：

```json
{
  "enabled": true,
  "capture4xx": true
}
```

修改状态：

```http
POST /api/admin/dev-mode
Content-Type: application/json

{
  "enabled": true,
  "capture4xx": true
}
```

你也可以只修改其中一个字段，未提供的字段会保留当前值。

### 2.3 通过 config.json 开启

也可以直接编辑本地配置文件：

```text
~/.local/share/copilot-api/config.json
```

添加或修改如下配置：

```json
{
  "devMode": {
    "enabled": true,
    "capture4xx": true
  }
}
```

## 3. 使用方法

### 3.1 等待 4xx 请求被捕获

开启 `capture4xx` 后，系统会自动捕获所有返回 4xx 的上游请求。

捕获内容包括：

- 完整的出站请求体
- 脱敏后的请求头
- 上游响应体
- 上游响应头

其中敏感头会被替换为 `***`，例如：

- `Authorization`
- 各类 `token` 相关请求头
- 其他敏感认证类请求头

这意味着你可以安全地查看捕获记录中的请求结构，但不能直接从中恢复认证信息。

### 3.2 进入重放页面

1. 在请求历史列表中找到一条 4xx 请求。
2. 点击进入请求详情页。
3. 点击工具栏中的 **Replay** 按钮。
4. 进入 `/requests/:id/replay` 页面。

只有当该请求存在捕获数据时，**Replay** 按钮才可用。

### 3.3 编辑与发送

#### 账号选择

- 默认会选中原始请求使用的账号
- 原始账号会标记为 **original**
- 你可以切换到其他可用账号进行重放

#### 请求头编辑

- 业务头可以自由编辑、添加、删除
- 认证头会显示为 `***`，并且是只读的
- 实际发送时，系统会根据当前所选账号自动注入真实认证头

#### 请求体编辑

- JSON 模式支持格式化
- JSON 模式支持语法校验
- 可以随时重置为原始捕获值

#### 发送模式

- **Collect**：等待上游完整响应后统一展示
- **Live**：实时流式展示上游返回的每个 chunk

编辑完成后，点击 **Send** 发送重放请求。

### 3.4 查看响应

发送完成后，可以在响应面板中查看以下内容：

- **Raw 标签**：查看上游原始响应，可能是 JSON、SSE 或纯文本
- **Translated 标签**：查看经过本系统 translation 层转换后的 Anthropic 格式响应，仅 `/v1/messages` 请求可用
- **Headers 标签**：查看上游响应头

如果原始请求不是 `/v1/messages`，则通常只有 Raw 和 Headers 视图具有实际意义。

## 4. 注意事项

- 重放会向 GitHub 发送真实请求，并消耗上游账号的真实配额
- 重放请求不会写入主请求历史
- 重放请求不会影响 premium 统计
- 重放请求不会写入 session affinity
- 捕获的数据会随主请求历史一起清理，保留期为 35 天
- 请求体中可能包含用户 prompt 等敏感内容，请注意数据安全
- `devMode.enabled` 是后端硬门闩；关闭后，所有重放相关端点都会返回 `403`，即使请求携带了合法的 `ADMIN_TOKEN`

## 5. 故障排查

### “Replay” 按钮不显示

请先检查 Developer Mode 是否已开启。

重点确认：

- Settings 页面中的 **Enable Developer Mode** 是否已开启
- 或 `devMode.enabled` 是否为 `true`

### “Replay” 按钮灰色不可点

这通常表示该请求没有捕获数据，常见原因包括：

- 该请求发生在 `capture4xx` 开启之前
- 该请求不是 4xx
- 该请求未被捕获成功

### 重放返回 403

表示 Developer Mode 未开启。

请检查：

- `GET /api/admin/dev-mode` 返回的 `enabled` 是否为 `true`
- 或 `config.json` 中的 `devMode.enabled` 是否已开启

### 重放返回 404

通常表示以下两种情况之一：

- 捕获数据已经过期并被清理
- 原始请求记录已经不存在

如果是历史较久的请求，优先考虑数据已随请求历史一起清理。
