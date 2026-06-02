<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# chat-completions

## Purpose
OpenAI-compatible `/v1/chat/completions` endpoint handler.

## Key Files

| File | Description |
|------|-------------|
| `route.ts` | Route registration for `/v1/chat/completions` |
| `handler.ts` | Request handler with account selection and upstream routing |
| `support.ts` | Supporting utilities for chat completions |

## For AI Agents

### Working In This Directory
- Less complex than `/v1/messages` as it's closer to native OpenAI format
- Verified by `tests/chat-completions-handler.test.ts`

## Dependencies

### Internal
- `src/lib/` - Account manager, config, error handling
- `src/services/copilot/` - `create-chat-completions.ts`
