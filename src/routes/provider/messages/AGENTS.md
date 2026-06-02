<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# messages (provider)

## Purpose
Provider-specific message endpoints that bypass Copilot and hit provider APIs directly.

## Key Files

| File | Description |
|------|-------------|
| `route.ts` | Route registration for provider messages |
| `handler.ts` | Direct provider message handler |
| `count-tokens-handler.ts` | Token counting via direct provider API |

## Dependencies

### Internal
- `src/lib/` - Account manager, config
- `src/services/providers/` - Direct provider clients
