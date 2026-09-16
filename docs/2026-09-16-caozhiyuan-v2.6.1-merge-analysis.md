# caozhiyuan v2.6.1 → all：功能取舍与合并方案

分析日期：2026-09-16。本文件保留合并前的分析基线及建议。**方案已获确认并完成实现与本地验证**；最终行为见 [升级说明](merge-v2.6.1-upgrade.md)，实施结果及验证范围见 [合并验收记录](2026-09-16-merge-validation.md)。下文“当前冲突”“本轮是分析”等表述均指分析时的状态。

建议保留 `all` 的多 GitHub Copilot 账号调度、Admin-UI、请求记录/回放及 HTTP MCP 能力，以 `caozhiyuan` 的最终版本为依据，移植公共功能及修复。继续完成当前普通合并，保留双方提交关系；按功能适配，不能对全部冲突统一选 ours/theirs，也不建议再次先提交一个只记录上游血缘的空合并。

## 1. 比较范围与事实基线

| 项目 | 本次核对结果 |
| --- | --- |
| 当前分支及合并前 HEAD | `all`，`ae80fe66794999f1bb52049ea5cda0a5da6766d6` |
| 正在合并的目标 | `1c48460142a484d31fa56e79fa60a96d39ddd54e`，上游 `v2.6.1` |
| 本地上游引用 | `refs/heads/caozhiyuan`、`refs/remotes/caozhiyuan/dev` 与 `MERGE_HEAD` 一致 |
| Git 合并基点 | `590bc1473e224dbb2d588d3cfb475f823de3ad74`，上游 `v2.0.1` |
| 上一次上游合并 | 2026-08-10 的 `6e4b0076`；第二父提交即 `590bc147` |
| 此后上游范围 | `590bc147..1c484601`：236 个提交，净变化 204 个文件 |
| 当前未解决冲突 | 106 个路径：Electron 及专用发行/构建 29、服务端 43、测试 23、其余构建/文档 11 |

上次 `6e4b0076` 的文件树与其第一父提交 `2e12ed8d` 完全相同，随后 `all` 用六个提交实现了实际适配：

- `27841fb3`：公共配置、Provider、日志等更新。
- `d7a6473a`：Responses Lite 翻译核心。
- `4c2388df`：Responses Lite 接入多账号调度。
- `5c2a77ed`：Codex 兼容模型目录。
- `9d63533f`：Alpha Search 接入多账号 Responses。
- `ae80fe66`：上述能力接入 Admin-UI。

因此这些功能已经存在，本次要补的是它们在 `v2.0.1` 之后的增强。`all/package.json` 仍写着 `1.14.22`，不能据此判断上次合并范围。

本报告核对了完整提交列表、基点到目标的净差异，以及双方相关实现和测试源码。事实针对上述固定提交；未获取远端新提交、未调用真实上游 API，也未把源码里的价格/模型表当作当前官方价格保证。工作区存在冲突，分析时使用提交快照，避免把冲突文件当成可运行实现。

## 2. 按功能整理的吸收清单

“适配吸收”表示保留功能目标，按 `all` 的架构实现；不等于复制整个上游文件。提交号用于追溯，取舍以目标提交的最终内容为准。

| 编号 | 上游新增或增强的功能 | 对 all 的建议 | 代表提交 |
| --- | --- | --- | --- |
| F01 | 上游 HTTP/Responses WebSocket 超时、空闲回收、缓冲上限与资源释放；断开客户端后的结果收尾 | **优先适配吸收**。接入现有请求捕获、账号调度和 WebSocket bridge | `973a66ec`、`1038f093`、`940636e5`、`69fea0a4`、`f1332d30` |
| F02 | 流式中断产生可识别错误；尚未初始化、只有 thinking、未收到结束事件时正确失败 | **吸收**。保留已有用量记账、错误分类和账号额度结算 | `0de33848`、`142c1346`、`e8109f57`、`230be9ba`、`405634d7` |
| F03 | Responses Lite 工具兼容：分片参数解码、strict、namespace 描述、custom tool 的 `ctc_` ID、空文本工具结果、历史工具调用不擅自增加可用工具 | **吸收**。合入既有翻译核心，继续保留 all 的工具搜索与上下文衔接 | `1e29250b`、`0666b2db`、`6bff4196`、`7a3af2ce`、`068ae58e`、`475d4078`、`06310d90`、`481b54d4` |
| F04 | reasoning 按原生 Responses / Messages 适配路径隔离；保留空 thinking 的签名；兼容 OpenRouter 风格 `reasoning` 字段 | **吸收**。在最终路由确定后过滤，Provider 路径也必须覆盖 | `7ee25045`、`b2bad8e1`、`09aadac4`、`619c45a6`、`17f2e1f2` |
| F05 | 缓存与请求格式：`cache_control`、从会话提取 `prompt_cache_key`、保留 GPT/Codex 中途系统消息的位置、`max_completion_tokens`、Copilot 工具内容默认字符串 | **适配吸收**。沿用 all 的会话归属/原始模型信息；不把 token 参数名变化错误推广到其他协议 | `e835b566`、`5ec7c125`、`07be78a6`、`643f6a0b`、`e50075ac`、`7ec6bb5e`、`11071375`、`d2600fff` |
| F06 | `ultra` 等 reasoning effort 兼容、按模型能力规范化，扩展 Provider Responses 支持 | **部分按 all 语义适配**。引入别名和 Provider 覆盖，保留 all 已有的用户意图优先级及档位选择规则 | `153b83d5`、`3188141c` |
| F07 | Codex 模型目录离线兜底、按 Provider 排序、重新纳入支持 Responses 的 Copilot 模型、上下文窗口修正、内置 Provider 能力/价格表、新模型 | **适配吸收**。继续从多账号可用模型集合生成目录，保留模型别名与可见性规则 | `34aee79a`、`65ae1f12`、`70425ce9`、`7c58fffe`、`a5e130ca`、`ce36c1de`、`c3874c13`、`0e419052`、`eb9dfe4a` |
| F08 | Codex 客户端非 GPT/Codex 模型走 Messages 适配；DeepSeek 的 code mode / Responses Lite 兼容策略；工具调用提示 | **按 v2.6.1 最终行为吸收**。仅在相应客户端/模型条件下生效，并保留 all 调度上下文 | `85ecad58`、`b9c3cd24`、`0e0c049d`、`b0fb5e95`、`b2d68b80` |
| F09 | Provider 扩展：Azure Entra、Kimi 协议可选、OpenCode 会话头、Grok/Muse 等协议识别；企业命名空间模型不误判为 Provider | **适配吸收**。鉴权类型不能随协议切换丢失；Admin-UI 同步新字段 | `3ec33173`、`5a989af3`、`ff3bd9fa`、`b387dedd`、`c8dacf25`、`d20f336f`、`707db750` |
| F10 | Copilot token 响应携带专用 API 地址，修复 token 与 business/enterprise 主机不匹配 | **必须重做多账号等效实现**。更新对应账号的 token 与地址，不能只写全局 state | `c21a7eca`、`291d08f6` |
| F11 | Codex 保存多个账号、别名、选择活动账号、移除闲置账号；刷新并发合并、刷新超时、跨进程持久化锁 | **吸收后端与 CLI，建议补 Admin-UI**。这是 Codex Provider 的凭据管理，不是 Copilot 多账号负载均衡 | `1e928d43`、`9adad175`、`ea90dbc0`、`cf0a5f92` |
| F12 | 图片生成/编辑支持模型映射与 Provider 路由；multipart 文件落临时磁盘、限额与清理；避免提前读取/错误重建请求体；输入图片字段清洗 | **吸收**。同时兼容 all 的模型别名策略、请求日志以及压缩请求中间件 | `8d68ba3b`、`4f7039dd`、`563cea98`、`c45562e5` |
| F13 | Alpha Search 重建请求兼容性与非 GPT 搜索模型回退；Web Search 降低 reasoning 和搜索上下文开销 | **适配吸收**。搜索仍经过 all 的账号选择、归属与结算链路 | `51ec2ac9`、`c70fce99`、`f534b05f`、`f1332d30` |
| F14 | 统计区分今日/本周/近 7 天/本月/近 30 天/全部；日统计批量查询；峰谷价格；更新内置价格数据 | **吸收并同步 Admin 统计页**。保留 AIU、Premium、多币种与已有历史账目 | `84e2ff0b`、`607c3dda`、`7cba0bab`、`9adad175`、`ada83f0d` |
| F15 | 配置和凭据原子写；损坏/不可读配置拒绝回退覆盖；OAuth 日志避免输出 token | **优先吸收**。all 的 Admin 配置写入已有临时文件 rename，须合并为一致的持久化规则 | `e131cd91`、`dfba9590`、`5d7ea5b0`、`cb0eac68`、`65570e40` |
| F16 | `auth keys` 管理网关密钥、显式监听地址、非回环监听要求密钥、限制 CORS、移除 `/token`、环境变量传 GitHub token | **适配吸收，明确部署兼容性变化**。保留 `ADMIN_TOKEN` 和 all 的账号引导流程 | `3777d988`、`e1551309`、`555e36de`、`f344c273`、`00ae3d7f` |
| F17 | Windows 交互认证修复；MCP stdio 启动加速；工具搜索桥的精确授权 hook；Claude 启动配置提示 | **选择性吸收**。MCP 快路径必须识别 all 的 HTTP 参数；Claude 默认 effort 不宜覆盖用户配置 | `2f2e1ddf`、`999a08f8`、`8d448eec`、`94993f8a`、`1bf0f2ab`、`df1f0561` |
| F18 | 日志跨日轮转、关闭旧文件后清理、减少模型目录日志 | **吸收**。保留 all 的日志级别设置及回放链路 | `c32cc8a6`、`f1ed448e` |
| F19 | 非 root 容器、显式数据目录初始化、健康检查、依赖/构建工具更新、单一 Bun 锁文件 | **适配吸收**。保留 Admin 构建与 all 数据目录、发布标识，删除所有 Electron 构建依赖 | `3f03c244`、`5fa4e608`、`cb7bb0aa`、`ad6f358d`、`3f446ce4`、`d5b1a0f0`、`be972803`、`5498c23b` |

F03 中上游还把无效的**历史 function arguments**降级为 `{}`。建议只保留这项翻译兼容范围，不扩展成“任何工具参数错误都静默忽略”；流式 custom tool 包装格式损坏仍应产生错误。

已有等效实现要合并去重：all 已经清洗 `internal_chat_message_metadata_passthrough`，不必再叠加一个重复清洗流程；Kimi 的 `openai-compatible` 默认、Admin API key 编辑、token usage 自定义 SQLite 路径也已经存在。对应条目应补后续差异，而非作为全新功能重做。

## 3. 必须按 all 架构实现的部分

### 3.1 Copilot token 与企业 API 地址必须按账号绑定

上游 `src/lib/token.ts:applyCopilotTokenResponse()` 把 token 和 `endpoints.api` 写入全局 state。`all` 的主要路径位于 `accounts-manager.ts` 与 `accounts-manager-auth.ts`，当前登录/刷新只接收 token，而额度刷新会从 usage 响应更新 `account.copilotApiUrl`。

建议：

1. 在账号初始化、主动刷新、后台刷新各入口，把 token 响应作为整体应用到目标 `AccountRuntime`。
2. 继续使用已有认证快照校验，避免旧认证请求覆盖账号重新登录后的状态。
3. 给地址来源建立优先级：当前 token 响应地址优先；没有该地址时才采用 usage 地址或既有回退策略。额度刷新不能覆盖当前 token 的权威地址。
4. 由 `AccountContext` 将正确地址传给 Chat、Messages、Responses、模型获取和搜索请求。
5. 认证身份/账号类型变更时使旧地址失效；token 轮换缺少地址的行为必须有明确测试，不能让另一账号的地址泄漏进来。

验收关键例：账号 A 的 token 绑定 enterprise，账号 B 绑定 business；两者并发请求及额度刷新后仍使用各自地址。只改 `get-copilot-token.ts` 的返回类型并不能实现这项修复。

### 3.2 传输增强要覆盖 all 实际使用的 HTTP 与 WebSocket 实现

`all` 的 Copilot Responses 连接池主要位于 `src/services/copilot/create-responses.ts`，同时存在客户端 WebSocket bridge 及 `responses-bridge-registry.ts`。上游增强主要围绕通用 `responses-websocket.ts` 展开，不能假定改了通用模块，all 的 Copilot 路径就自动得到修复。

建议先保留现有调度结构，移植传输规则；是否统一两个连接池实现可另做重构。必须保留：

- 账号 token 指纹、模型、会话和子代理的连接隔离；同一会话连接复用。
- 上游连接空闲失效后通知下游 bridge，避免增量会话卡在已失效的连接上。
- 账号选择、会话/响应 item 归属、额度预留、错误重试和记录回放。
- `copilotFetch` 的捕获能力、请求上下文中的可注入 fetch，以及已有出站 header 记录；上游新 helper 直接调用全局 fetch，不能直接绕开这些入口。

上游最终语义尤其需要保留清楚：**发送前客户端已取消则不发请求；已经发送后，客户端断开不直接中止上游，而是停止向客户端写入，继续读取至结束或超时。**显式提前结束迭代器才取消底层读取。这在 `upstream-http-lifecycle.test.ts`、`upstream-drain*.test.ts` 中有对应场景，不能概括成“客户端取消就 abort 上游”。

接入 all 时，结束、失败、超时和断开后的读取都必须走一次且仅一次的用量记录及额度结算。不可提前释放后又重复记账，也不可把已接受的请求盲目重发给另一个账号。

上游默认值可作为本次新增配置的起点：响应头 5 分钟、流空闲 5 分钟、WebSocket 打开 30 秒、连接池空闲 60 秒、缓冲 8 MiB/1024 条。通过 `upstreamTransport` 配置，并兼容上游旧键迁移；不是给整次生成设置 5 分钟总时长限制。

### 3.3 模型目录、reasoning 与配置不能退回单账号实现

模型目录仍基于 `all` 的 `getAvailableModels()` 生成，而非上游的全局 `state.models`；保留可用账号过滤、模型别名、隐藏原名以及用户关闭某个 Codex 模型的能力。补上原生 Responses 模型、离线目录、分组排序与内置能力表。

两边配置形状不同：

| 含义 | all 已有结构 | 上游当前结构 | 建议 |
| --- | --- | --- | --- |
| 模型上下文、输入模态、reasoning 能力 | `providers.*.models.*.codex.*` | 直接放在 `models.*` | 保持 all 的 `.codex` 公开格式，内部归一化后供目录/路由使用 |
| 模型启用、并行工具能力 | `.codex.enabled`、`.codex.supportsParallelToolCalls` | 上游模型生成策略不同，部分能力直接固定 | 保留 all 的显式开关，不用默认值覆盖 |
| 新增 reasoning 消息字段 | 无 | `models.*.reasoningField` | 增加为通用 Provider 模型字段，并补 UI/校验 |
| 传输参数 | 无该配置块 | `upstreamTransport` | 纳入 all 的统一 config、Admin API 与前端白名单 |

建议能力数据优先级明确为：用户显式配置优先，远端有效能力补充，内置表兜底；价格仍遵循显式配置/内置表及上游直接报费的既有规则。离线目录只是兼容性兜底，不代表某个本地账号实际拥有模型权限。

`reasoning-effort.ts` 是同名独立新增的冲突。all 已有“显式值 → 原始请求模型默认值 → 实际目标模型默认值”、显式 `null` 关闭回退，以及选中实际账号/模型后重新规范化的行为。

**建议保留 all 的这些规则及“最近支持档位、同距取低”的选择方式，只补 `ultra → max` 等兼容能力，并使 Provider 路径复用同一套规范化。**上游改用“最高的不超过请求值的档位”，两者并不等价。例如请求 `high`、可用 `[low, xhigh]` 时，all 选 `xhigh`，上游选 `low`。本次不应把这种策略变化藏在冲突解决中；若另行选择上游规则，需要明确修改相应行为测试。

### 3.4 Codex 多账号单独建模，保留上游功能边界

上游最终版本支持最多 **3 个 Codex 账号、一个被选择的活动账号**，CLI 可以列出、使用别名选择、删除非活动账号。它没有实现 Copilot 那种账号池调度、自动故障转移或额度分配。

建议在 `codex` Provider 内吸收此功能，保留既有单账号凭据格式的兼容读取及写入迁移，使用 `providers.codex.accountId` 保存选择；不要塞入 GitHub Copilot 的账号注册表或给它套用 Copilot Premium 配额。

凭据层要同时带入最终版本的原子写、跨进程读改写锁、账号管理锁、删除后刷新不能复活账号、进程内刷新请求合并、30 秒刷新超时，以及“刷新已成功但写盘失败时重试写入”的逻辑。**跨进程文件写锁不等于跨进程 OAuth 刷新去重**，不能承诺多个网关进程共用同一个旋转 refresh token 一定安全。

CLI 切换当前要求重启服务，Admin-UI 第一阶段也应明确区分“已选择”与“当前运行中使用”的账号，提示生效条件。若要热切换，必须另外处理正在进行的请求、刷新任务、Codex WebSocket 池与模型缓存的账号一致性，不能只改一个全局 token。

### 3.5 配置、安全和监听方式必须接入现有 Admin 架构

- 保留 `all/src/lib/config.ts` 的完整配置定义。把原子写、坏配置拒绝启动、API key 管理和新字段移植进来，不同时恢复一个独立缓存的 `config-store.ts` 作为第二套配置来源。
- Admin 配置写入已有临时文件/rename，实现基础不是空白；补齐一致的持久化与错误传播规则。任何写入失败都不能被描述成保存成功。
- `auth.apiKeys` 是网关调用密钥；`ADMIN_TOKEN` 是 all 已有管理面认证；Copilot/Codex token 是上游凭据。三者保持分离，不用上游 `auth.adminApiKey` 替换现有管理面。
- 吸收 `auth keys` CLI；兼容 all 的旧 `COPILOT_API_KEY`/`config.apiKey` 来源。清空新密钥时不能让旧来源无提示重新生效。
- `COPILOT_API_GITHUB_TOKEN` 在 all 中应接入现有临时高优先级账号入口，CLI 参数仍优先；不能覆盖或清空已经注册的多个账号。
- 建议吸收 `--host`、非回环监听必须有有效网关 key 和相应 CORS 规则。CLI 缺省回环地址属于可见变更，已有远程部署应通过显式 `HOST`/`--host` 迁移；Docker 容器内部显式监听 `0.0.0.0`，宿主发布地址独立配置。
- `/admin`、`/api/admin` 和显式启用的 MCP 路由保留各自认证/CORS 契约。HTTP WebSocket upgrade 走独立入口，须同步验证非回环鉴权，不能只检查 Hono 中间件。
- 建议移除返回上游 token 的 `/token`，并清理引用与测试；它在 all 中还读取单例 `state.copilotToken`，本身也不适合多账号语义。

这些是拟实施的代码/部署模板变化。本轮没有改动现有运行服务、监听地址或真实配置。

### 3.6 图片、搜索和缓存沿用统一路由身份

图片模型映射在 JSON 请求和 multipart 请求中都要生效。重建 multipart 时重新生成 boundary/content-length，保留文件字段与内容；解析失败不能再读取一个已经消费的原始 body。合入临时文件限额、路径名清洗、异常清理和延时清理测试。

上游把 zstd 解压从全局移动到 Responses 路由，图片转发需要重新核对请求体消费边界。all 现有中间件只在 `Content-Encoding: zstd` 时读取 body，普通 multipart 并不会被它提前消费；实施时应分别验证压缩 Responses、Provider Responses、图片原样转发以及已有其他压缩入口，不能简单移动中间件后丢掉旧能力。

Alpha Search 的非 GPT 回退和 Web Search 的低开销参数是公共改进，但最终搜索请求仍须通过 all 现有多账号选择。原始模型用于别名/亲和性，实际目标模型用于能力检查和上游调用；请求 ID、session ID、subagent marker 在 Responses→Messages→搜索路径中保持一致。

缓存优化也遵循这条身份链：把会话标识用于缓存键，不用每次请求生成的 UUID 代替稳定 session，不把不同账号或独立子代理的连接状态混在一起。OpenCode 的 `x-opencode-session` 只发给相应 Provider。

### 3.7 统计后端与 Admin 页面必须一起改

all 的 Admin API 和前端当前都只接受 `day/week/month`，上游普通 `/token-usage` 路由则已经支持六个新周期。仅保留自动合并成功的 store/普通路由，会留下 Admin 入口不一致。

建议统一周期解析并保留旧查询兼容：

| 原参数 | 新语义/参数 |
| --- | --- |
| `day` | `today`，今日 |
| `week` | `last_7_days`，近 7 天，不能改成本周 |
| `month` | `last_30_days`，近 30 天，不能改成本月 |
| 新增 | `this_week`、`this_month`、`lifetime` |

Admin 的摘要、日趋势、事件分页、TypeScript 类型和中英文本同步更新。`lifetime` 表示数据库现存记录的全部范围；对空数据库返回一致空结果，不能暗示它能恢复被删除的历史数据。

峰谷价格按事件记账时间选择，计算和 `created_at_ms` 使用同一时间；保存当时成本。上游窗口使用 UTC 分钟/星期，统计周期仍有本地日期语义，两者不能混淆。保留 all 已有的 Copilot AIU 换算、Premium 统计、OpenRouter 上游报费优先及多币种展示，不用新价格回算旧账。

### 3.8 MCP 加速不能吞掉 all 的 HTTP 模式参数

上游 `isMcpFastPath()` 只检查第三个 argv 是 `mcp` 且没有 help，明确忽略其余参数；上游 `mcp` 只有 stdio，所以成立。all 已支持：

```text
copilot-api mcp --transport http --host ... --port ... --path ...
```

直接移植会把该命令错误启动成 stdio。建议快路径仅匹配无参数的 `mcp`；有参数或前置全局选项时继续走现有 CLI 解析，复用 all 的 `src/mcp-server.ts`，避免新建第二套只支持 stdio 的 MCP 实现。

工具搜索 PermissionRequest hook 可以吸收，但只匹配既定的桥接工具名；它只放行工具查找桥，不意味着授权被查出的全部业务工具。保持 all 独立 MCP HTTP 和主服务 `/mcp` 的显式启用方式。

Claude 启动辅助配置可补连接超时与 token reminder 设置说明。上游固定 `CLAUDE_CODE_EFFORT_LEVEL=max` 属于偏好性默认值，建议尊重用户已设置的值，不作为所有请求的强制推理档位。

### 3.9 容器、SQLite 和构建适配

上游 Docker 初始化白名单只知道它自己的状态文件。all 还使用 `tokens/`、`accounts-registry.json`、`models.json`、`admin.sqlite` 及其 WAL/SHM 文件。照搬白名单可能让非 root 进程无法读取多账号 token，或无法写入 Admin 数据库。

建议：

- 保留 Admin-UI 安装、类型检查、构建和静态产物打包；builder 包含构建所需开发依赖，runner 只装生产依赖。
- 非 root 迁移明确覆盖 all 自有状态文件；按精确路径修正权限，不对任意宿主挂载目录递归改所有权。
- Compose 镜像名称改成 all 的实际构建/发布产物，不能继续使用 `ghcr.io/caozhiyuan/copilot-api:latest`，否则运行的是上游单账号产品。
- `COPILOT_API_SQLITE_DB_PATH` 在 all 已用于 token usage 数据库；它不会自动改变 `admin.sqlite` 的路径。保留两者边界，分别验证权限和持久化。
- 图片上传上游允许总计 128 MiB，而 Compose 模板的 `/tmp` 只有 64 MiB。建议给临时上传目录独立、可配置的容量预算或相应降低上传上限，并测试并发上传；不能把“流式落盘”误当作不需要临时磁盘容量。
- 接入上游 Hono/Undici 等公共依赖更新，以及功能所需的 `@azure/identity`、`@clack/prompts`、`@fastify/busboy`。不引入 Electron。
- 若采用 `tsdown 0.23`，同步其配置变化，在 CI/release **安装和构建之前**准备符合要求的 Node（源码构建至少 22.18）；all 主服务继续运行于 Bun，不引入 Node/srvx 替换 `Bun.serve`。
- 保留 `@nick3/copilot-api`、本仓库发布地址、Admin 脚本及原有功能开关。锁文件由最终依赖清单生成；上游删除 npm 锁文件的整理可吸收，但不能手工拼接 `bun.lock` 冲突段。

## 4. Electron 中的能力，哪些要在 Admin-UI 等效实现

| 能力 | all 现状 | 建议落点和优先级 |
| --- | --- | --- |
| 网关 API keys | 设置页已能编辑 `auth.apiKeys` | **复用现有页面**，补无密钥/对外监听状态及 CLI 变更后的刷新；无需新建安全中心 |
| Codex 多账号列表、别名、活动账号、删除闲置账号 | 只有 Copilot 账号管理，Codex 主要通过 CLI 授权 | **建议新增 Codex Provider 账号区域**，与 Copilot 账号池区分；CLI/后端可先交付，UI 可紧随其后的独立提交 |
| Codex 添加授权 | 后端已有 Codex OAuth，Admin 没有对应完整账号管理流程 | 建议复用后端授权能力；远程管理需处理回调在浏览器本机/服务器之间的位置差异，可提供粘贴回调结果，不能直接搬 Electron IPC/本机浏览器假设 |
| 六种统计周期和全部数据趋势 | Admin 当前三个周期 | **本次应同步完成**，否则新统计能力在 Admin 入口不完整 |
| Entra、`reasoningField`、峰谷价格、传输参数 | 新字段不在 Admin 的类型、白名单或表单中 | **本次应补齐类型、校验及保存回读**；复杂峰谷规则可先提供受校验的高级 JSON 编辑，不能保存时静默丢字段 |
| 新模型默认能力和价格 | 已有模型页、Provider 模型能力编辑器 | 复用现有页面，展示有效能力/来源；保留 `.codex` 结构和显式覆盖，不重复建目录页 |
| Kimi 协议选择 | 设置页已有 Provider type，当前快捷模板也已是 `openai-compatible` | 校准默认值和提示即可；主要补 CLI 可选协议，通常无需新增 UI |
| 监听 host、SQLite 路径 | 由进程启动/环境控制 | 暂不做“保存即生效”的网页表单；可选只读状态和重启提示。路径不应让远程网页随意切换正在使用的数据库 |
| 更完整的授权错误显示 | Electron 改进了错误显示 | 新 Codex 管理流程应显示经脱敏的明确错误；已有 Copilot 页面按自身接口处理，不搬 Electron 组件 |
| 托盘、窗口、开机自启、Electron 自动启动服务、桌面安装/更新 | all 是网页管理与服务进程 | **不迁移** |
| 独立 usage-viewer 的端点凭据存储 | all 已有 Admin 统计页，调用同源 Admin API | 不恢复旧 viewer；若未来支持切换远端管理地址，再实现按目标 origin 隔离的凭据存储 |

最小 UI 完整性包括：新后端配置可以通过 Admin 保存、重新加载后保持不变；旧配置不会因为打开/保存设置页而消失。Codex 可视化账号管理属于建议补齐项，不应把它扩展成未经设计的 Codex 自动负载均衡。

## 5. 明确排除与上游撤回项

### 5.1 排除独有产品形态

- 全部 `desktop/` 页面、Electron 主进程/IPC/preload、桌面设置存储、桌面测试、桌面锁文件、安装脚本。
- `.github/workflows/release-desktop.yml`、`tsdown.desktop.config.ts` 以及 package/CI 中桌面依赖和脚本。
- 恢复 `pages/index.html`、新增 `/usage-viewer` 页面、替换现有 `/api/admin` 的单账号管理 API。
- 上游 README 中将本项目改写为 Electron/单账号发行版的内容，以及包名、仓库名、Docker 镜像归属的覆盖。

不是看到“desktop”就把整个提交丢掉：例如 `server-host-shared.ts` 是服务端仍会使用的纯函数；`7d99e1a4` 的 Compose DB 环境设置可借鉴；`9adad175` 同时包含 Codex 后端、峰谷计价和 Electron UI，必须按功能拆开。

### 5.2 以最终版本为准，不恢复已撤销的实验

| 历史修改 | 最终处理依据 |
| --- | --- |
| Copilot multi-agent transport 实验 `6e3d38df` | 已被 `2cd274f6` 撤回 |
| 子代理 WebSocket 请求延迟 `e2071f37` | 已被 `e2558571` 撤回 |
| Bun WebSocket/Undici 兼容实验 `0e3a85a5` | 已被 `059ece71` 撤回 |
| 服务端 ping/pong 日志 | `5dea2a45` 撤回；不能因其与 ensure-electron 同提交而误带回来 |
| GLM 单文本 assistant 自动摊平 `8eb5b1a7` | 已被 `3a679eff` 撤回 |
| MCP search 声明 read-only `2adf855d` | 已被 `ca99203c` 撤回；最终使用精确权限 hook |
| 恢复 DeepSeek code mode/tool tips `5e17c0a5` | `b2d68b80` 又撤回：最终 DeepSeek 禁用 code mode 与 Responses Lite，跳过相应提示 |
| 一度去掉 Copilot Responses 模型目录项 | 后来由 `70425ce9` 重新加入，应保留最终目录能力 |
| 临时增加 `unrun` | `5498c23b` 已删除，改为保证源码构建所需 Node 版本 |
| 中间版本 Docker 独立文档、额外 Compose 文件和 Docker test workflow | 目标版本已进一步整理/删除，按最终文件树取舍 |

内置模型表也经历过新增、重命名、删除，应该合入最终表及其查找规则，不汇总所有历史名称重新生成一张“并集”表。配置中的自定义模型仍按原有配置语义保留。

## 6. 建议的实际合并流程

### 6.1 保留当前合并，先准备恢复点

开始实施时先记录 `HEAD`、`MERGE_HEAD`、未合并索引、暂存/未暂存差异及必要工作区快照；备份分支只能保存提交，不能代替当前冲突现场备份。不要 `merge --abort`、硬重置，或用整树覆盖丢失已有合并结果。

本轮已检查工作区状态并记录校验值，但没有创建备份分支或操作 Git 索引。`caozhiyuan` 短引用在本仓库会出现歧义提示，后续操作使用完整 `refs/heads/caozhiyuan` 或固定提交号。

### 6.2 按依赖顺序解决和验证

| 批次 | 工作内容 | 进入下一批的条件 |
| --- | --- | --- |
| 1 | 清理 Electron/旧 viewer；保留 all 的脚本、Admin 构建、Bun 主服务和认证结构；确定新类型/配置字段的唯一归属 | 无双配置缓存/双类型定义；依赖清单明确 |
| 2 | 原子配置与凭据、Copilot 账号地址修复、Provider 解析/Entra、Codex 账号后端/CLI | 旧配置和凭据兼容，身份隔离及并发行为测试通过 |
| 3 | HTTP/WS 超时和缓冲、流式失败/收尾，接入 all 调度与 bridge | 多账号/子代理/断开客户端/回放场景通过 |
| 4 | Responses Lite、reasoning、工具/缓存、模型目录、图片、搜索 | 三种协议、Provider 路径与模型别名回归通过 |
| 5 | 周期统计和峰谷价格；Admin 新字段及统计 UI；部署配置与迁移说明 | 配置保存回读、旧周期兼容、容器多账号持久化通过 |
| 6 | 依赖锁文件、完整构建/测试、文档与最终差异审查 | 零冲突、无 Electron 引入、变更覆盖达标后才结束合并 |

此顺序是实施分组，不表示在未完成适配时提前提交 merge。全部必要适配完成后生成真实双父提交：第一父为本次 `all` 的 `ae80fe66`，第二父为 `1c484601`。可选的 Codex Admin 可视化管理随后单独提交，描述清楚 CLI 已支持而 UI 尚待补齐的边界。

不建议对 236 个提交逐个 cherry-pick：版本提交、revert 和相互依赖较多，容易重复移植并丢失本次合并关系。也不建议 `merge -s ours` 后把当前目标直接标为已吸收；遗漏功能会从下一次 Git 差异中消失，增加后续追溯难度。

### 6.3 不只审查 106 个冲突

自动合并成功的文件同样需要检查。当前已有新的 Electron 文件进入索引；`credential-store.ts`、`provider-resolver.ts`、`token-usage/store.ts` 等也可能自动合并成功，但它们依赖的类型、配置或调用方还没有完成 all 适配。

特别检查：

- `config-store.ts`、`provider-config.ts`、`lib/types/*`、`provider/utils.ts` 等“all 删除、上游修改”的文件，判断功能在 all 的实际承载位置。可保留无状态共享函数/兼容 re-export，但不能制造第二套独立配置或不一致类型。
- `CLAUDE.md` 的文件/符号链接冲突，以及 `CLAUDE.md~HEAD` 临时路径；保留适用的仓库规则，不把冲突临时产物当成新功能提交。
- 因跨目录重命名而自动套用的类型变更，例如 Anthropic 类型当前在 all 的 `routes/messages/anthropic-types.ts`。
- README、CI、package、Docker/Compose 中残留的 Electron 命令、单账号启动逻辑、上游发行标识。

## 7. 实施后的验收要求

本轮是分析，没有运行构建或测试；以下是实施后必须执行的验证，不是已经通过的结果。

| 场景 | 必须证明的行为 |
| --- | --- |
| 两个 Copilot 账号与不同企业主机 | 初始化、token/额度刷新及并发请求不串 token/地址；过期认证快照不能覆盖新状态 |
| 多账号 Responses 与子代理 | 亲和性、响应 item 归属、原始模型与实际模型、额度预留/释放保持正确 |
| 流式/断开/超时/缓冲溢出 | HTTP 与 WS 均有界收尾；错误格式正确；用量和额度只结算一次；bridge 能恢复 |
| 回放与出站请求捕获 | 新传输包装不绕过可注入 fetch；回放继续遵守不写正式请求统计/亲和性的契约 |
| Codex 账号迁移和并发 | 单账号旧格式、多账号明确选择、别名冲突、最多 3 个、活动账号禁止删除、刷新不复活已删账号 |
| reasoning 与工具 | `ultra`、null、默认优先级、不同账号模型能力、历史工具、custom tool 分片、空签名文本、跨传输过滤 |
| Provider 与模型目录 | Entra/显式 OAuth 在协议切换后正确；企业带斜杠模型不误路由；离线目录不破坏模型可见性和显式覆盖 |
| 图片与压缩请求 | JSON/multipart 映射、未知 Provider 回退、超限 413、损坏请求 400、临时文件清理、zstd Responses |
| 配置和管理 UI | 新字段保存后回读一致；旧 `.codex` 字段/密钥/别名保留；坏 JSON/不可读文件不会覆盖；管理认证继续有效 |
| 用量统计 | 六周期和旧参数别名、跨日/周/月/时区、空 lifetime、峰谷边界、历史成本保持、AIU/多币种正确 |
| MCP | 无参数 stdio、`--transport http`、自定义 host/port/path、全局选项、help、主服务 `/mcp` 均保留 |
| 容器/发行 | 非 root 可读写 token 和两类 SQLite；Admin 静态页完整；数据卷重启后保留；上传临时空间足够；发布产物属于 all |

自动化检查沿用仓库现有工具：

```sh
bun run typecheck
bun run typecheck:admin
bun test --isolate
bun run lint:all
bun run lint:admin
bun run build
```

定向测试按上表补到已有对应文件，新增/修改代码的单元测试覆盖至少达到仓库要求的 85%；对多账号路由、认证和传输边界增加有意义的集成场景。需要格式化时使用仓库 `bun run lint --fix <files>`，不用独立 Prettier 改写整个文件。

最终核对 `git ls-files -u` 为空、差异中没有冲突标记及 Electron 文件；审查完整暂存差异而非仅冲突列表。通过后再提交合并；推送、发布和部署是后续动作，不包含在本轮分析中。

## 8. 代码证据导航

下表路径是仓库内的修订定位，读取时使用 `git show <修订>:<路径>`。`all` 指本报告固定的 `ae80fe66`，`upstream` 指 `1c484601`，不是存在冲突标记的工作区内容。

| 核对点 | 主要证据 |
| --- | --- |
| all 多账号认证地址 | all：`src/lib/accounts-manager.ts`、`accounts-manager-auth.ts`、`types/account.ts`、`api-config.ts` |
| 上游 token 地址权威来源 | upstream：`src/lib/token.ts:applyCopilotTokenResponse`；`tests/token-copilot-url.test.ts` |
| all 的 WS 连接隔离与下游 bridge | all：`src/services/copilot/create-responses.ts:buildResponsesWebSocketPoolKey`；`responses-bridge-registry.ts`；`src/start.ts` |
| 上游客户端断开语义 | upstream：`src/services/upstream-http.ts`；`src/lib/sse.ts`；`tests/upstream-http-lifecycle.test.ts`、`upstream-drain.test.ts`、`upstream-drain-ws.test.ts` |
| 双方 reasoning 规则不同 | 双方：`src/lib/reasoning-effort.ts` 与 `tests/reasoning-effort.test.ts` |
| Codex 账号边界 | upstream：`src/lib/credential-store.ts:MAX_CODEX_ACCOUNTS`；`src/lib/token.ts:selectCodexAccount/removeCodexAccount/refreshCodexCredentialsOnce`；`src/auth.ts:runAuthCodex` |
| 模型与配置形状 | all：`src/lib/config.ts`、`src/routes/models/route.ts`；upstream：`src/lib/config-store.ts`、`builtin-provider-models.ts`、`src/routes/models/codex-models.ts` |
| Admin 缺少新字段与统计周期 | all：`src/routes/admin-api/route.ts:CONFIG_KEYS/PROVIDER_MODEL_CONFIG_FIELDS/PROVIDER_AUTH_TYPES/TOKEN_USAGE_PERIODS`；`admin-ui/src/lib/admin-api.ts`；`admin-ui/src/pages/settings-page.tsx`、`token-usage-page.tsx` |
| Admin 独立认证 | all：`src/routes/admin-api/route.ts:decideAdminAccess`；`src/server.ts` |
| MCP 快路径不兼容 HTTP 参数 | upstream：`src/lib/fast-path.ts`；all：`src/mcp.ts:runMcpCommand`、`src/mcp-http-config.ts`、`src/mcp-server.ts` |
| 存储位置与容器迁移 | all：`src/lib/paths.ts`、`admin-db.ts`、`token-usage/store.ts`；upstream：`docker-compose.yaml`、`entrypoint.sh` |
| 图片临时空间与资源限制 | upstream：`src/routes/images/temp-form-data.ts`、`edits-handler.ts`；`tests/images-temp-form-data.test.ts` |
| 峰谷价格与周期兼容 | upstream：`src/lib/token-usage/pricing.ts`、`peak-windows.ts`、`index.ts`、`store.ts`；`src/routes/token-usage/route.ts` |

建议确认的实施范围：**F01–F19 中标为吸收/适配的公共能力，加上 Admin 配置与统计的必要同步；排除 Electron 与旧 viewer；reasoning 选择策略保留 all；Codex 保持单活动账号，不扩展为账号池。**Codex 可视化账号管理建议作为紧接合并后的独立功能提交。
