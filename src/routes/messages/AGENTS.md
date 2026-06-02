<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# messages

## Purpose
Anthropic-compatible `/v1/messages` endpoint implementation. This is the primary and most complex route handler, handling request parsing, account selection, model normalization, subagent detection, warmup probe handling, compact request handling, upstream routing, and response translation.

## Key Files

| File | Description |
|------|-------------|
| `route.ts` | Exposes `/v1/messages` and `/v1/messages/count_tokens` endpoints |
| `handler.ts` | Main request orchestration: rate limits, auth, account selection, upstream routing, response translation |
| `non-stream-translation.ts` | `translateToOpenAI()` and `translateToAnthropic()` for non-streaming conversion |
| `stream-translation.ts` | Streaming event conversion between OpenAI and Anthropic formats |
| `responses-translation.ts` | Copilot Responses ↔ Anthropic Messages conversion |
| `responses-stream-translation.ts` | Streaming Responses ↔ Anthropic conversion |
| `preprocess.ts` | Compact request detection, cache control stripping, tool result normalization |
| `api-flows.ts` | Legacy flow orchestration (now superseded by `handler.ts`) |
| `count-tokens-handler.ts` | Token counting via Anthropic API or gpt-tokenizer fallback |
| `subagent-marker.ts` | Subagent marker detection (`__SUBAGENT_MARKER__`) |
| `anthropic-types.ts` | Anthropic API TypeScript type definitions |
| `utils.ts` | Shared utility functions for message handling |

## For AI Agents

### Working In This Directory
- `handler.ts` is the current source of truth for `/v1/messages` flow
- `api-flows.ts` still exists but orchestration is in `handler.ts`
- Preprocess changes require updates to `tests/messages-preprocess.test.ts`
- When working on `/v1/messages`, verify behavior in `tests/messages-handler.test.ts`, `tests/messages-preprocess.test.ts`, `tests/create-messages.test.ts`, and `tests/warmup-probe.test.ts`
- `stripToolReferenceTurnBoundary()` runs before `mergeToolResultForClaude()` in the handler flow

### Common Patterns
- Translation functions are pure (no side effects)
- Streaming uses SSE event format
- Model alias switching for warmup/compact/small model traffic

## Dependencies

### Internal
- `src/lib/` - Account manager, config, state, error handling
- `src/services/copilot/` - Copilot API clients

### External
- `gpt-tokenizer` - Token counting fallback
- `fetch-event-stream` - SSE parsing
