<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# responses

## Purpose
Copilot-native `/v1/responses` endpoint handler with streaming and non-streaming translation to/from Anthropic Messages format.

## Key Files

| File | Description |
|------|-------------|
| `route.ts` | Route registration for `/v1/responses` |
| `handler.ts` | Main request handler with translation layer |
| `stream-id-sync.ts` | Stream ID synchronization for response streaming |
| `utils.ts` | Shared utilities for response handling |

## For AI Agents

### Working In This Directory
- Uses `responses-translation.ts` and `responses-stream-translation.ts` from `messages/` directory
- Verified by `tests/responses-translation.test.ts` and `tests/responses-stream-translation.test.ts`

## Dependencies

### Internal
- `src/routes/messages/` - Translation utilities
- `src/lib/` - Account manager, config, error handling
