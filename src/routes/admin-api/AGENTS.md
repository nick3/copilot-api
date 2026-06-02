<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# admin-api

## Purpose
Admin API endpoints for programmatic access to account management, configuration, request replay, and auth session management.

## Key Files

| File | Description |
|------|-------------|
| `route.ts` | Main admin API route registration |
| `config-writer.ts` | Configuration read/write endpoints |
| `replay.ts` | Request replay endpoint for debugging upstream responses |
| `replay-translation.ts` | Translation utilities for request replay |
| `auth-sessions.ts` | Auth session management endpoints |

## For AI Agents

### Working In This Directory
- Protected by API key auth (`api-key-auth.ts`)
- Replay feature uses `dev-mode.ts` and `request-outbound.ts` for captured 4xx responses
- Replay is pure bypass: no `request_log`, no premium stats, no affinity writes

## Dependencies

### Internal
- `src/lib/` - Admin database, config, dev mode, request history
- `src/lib/accounts-manager.ts` - Account management
