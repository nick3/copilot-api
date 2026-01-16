# Findings

## Discoveries
- 配置位置与默认值：PATHS.CONFIG_PATH 位于 src/lib/paths.ts，配置结构与默认值在 src/lib/config.ts（AppConfig/defaultConfig/mergeConfigWithDefaults），启动时 start.ts 会调用 mergeConfigWithDefaults。当前 mergeConfigWithDefaults 会补齐 extraPrompts、freeModelLoadBalancing 与 forceAgent。
- X-Initiator 注入点：chat-completions 在 src/services/copilot/create-chat-completions.ts 里根据最后一条消息 role 判定（非 user -> agent）；responses 通过 src/routes/responses/utils.ts 的 getResponsesRequestOptions/hasAgentInitiator 计算并传给 src/services/copilot/create-responses.ts。
- Streaming 处理器：src/routes/chat-completions/handler.ts、src/routes/responses/handler.ts、src/routes/messages/handler.ts 均使用 streamSSE/stream.writeSSE 转发 SSE。
- 日志与配额链路：logger 记录落盘；request-history/account-manager 在 streaming finally 中写入 usage 与 premium 快照。现已新增 formatStreamLog/getPremiumInfo 与 setupPingInterval 以支持进度输出与 SSE keepalive，并补充日志/异常可观测性。

## Open Questions
- (已解决) README 配置章节已补充 forceAgent 说明。
