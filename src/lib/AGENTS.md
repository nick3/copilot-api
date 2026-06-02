<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# lib

## Purpose
Core business logic for the Copilot API proxy. Contains account management, quota tracking, authentication, configuration, rate limiting, session affinity, request history, error handling, and utility modules.

## Key Files

| File | Description |
|------|-------------|
| `accounts-manager.ts` | Multi-account manager with quota tracking, token lifecycle, and account selection |
| `accounts-manager-auth.ts` | Token refresh and GitHub Copilot auth state management |
| `accounts-manager-quota.ts` | Premium quota reservation system for concurrent requests |
| `accounts-manager-quota-scheduler.ts` | Background scheduler for premium quota refresh |
| `accounts-registry.ts` | Account persistence layer, reads/writes registry.json |
| `config.ts` | Application config from `~/.local/share/copilot-api/config.json` |
| `state.ts` | Global runtime state (tokens, models, rate limits) |
| `error.ts` | `HTTPError` class and `forwardError()` handler wrapper |
| `admin-db.ts` | SQLite-backed admin database (request history, usage stats) |
| `request-history.ts` | Request logging with 14-day retention, 200k row cap |
| `api-config.ts` | Copilot API headers and URL configuration |
| `rate-limit.ts` | Rate limiting middleware |
| `quota-refresh-scheduler-runtime.ts` | Runtime for periodic quota refresh |
| `api-key-auth.ts` | API key authentication for admin endpoints |
| `request-auth.ts` | Request-level auth token handling |
| `request-context.ts` | Request context propagation |
| `request-initiator.ts` | Tracks who initiated a request |
| `session-affinity-store.ts` | Session-to-account affinity caching |
| `session-ownership.ts` | Session ownership tracking for subagents |
| `account-affinity.ts` | Account affinity logic for repeated requests |
| `account-client-identity.ts` | Client identity management per account |
| `subagent.ts` | Subagent marker detection and propagation |
| `handler-utils.ts` | Shared utilities for route handlers |
| `models.ts` | Model registry and alias management |
| `compact.ts` | Compact request detection and handling |
| `dev-mode.ts` | Developer mode for request replay/capture |
| `request-outbound.ts` | Outbound request capture for replay |
| `copilot-rate-limit.ts` | Copilot API rate limit tracking |
| `token.ts` | Token management utilities |
| `tokenizer.ts` | Token counting via gpt-tokenizer |
| `proxy.ts` | Proxy configuration handling |
| `deviceid.ts` | Device ID generation |
| `logger.ts` | Logging setup with consola |
| `trace.ts` | Request trace ID middleware |
| `utils.ts` | General utility functions |
| `shell.ts` | Shell command execution helpers |
| `paths.ts` | Path resolution utilities |
| `approval.ts` | Approval workflow helpers |
| `opencode.ts` | Opencode integration |
| `stats-store.ts` | Statistics aggregation |

### Types

| File | Description |
|------|-------------|
| `types/account.ts` | Account type definitions |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `types/` | TypeScript type definitions (see `types/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- `accounts-manager.ts` is the central hub for multi-account operations
- Quota reservation in `accounts-manager-quota.ts` prevents overspend during concurrent requests
- Session affinity (`session-affinity-store.ts`, `account-affinity.ts`) enables sticky account routing
- The `state.ts` file holds global runtime singletons

### Common Patterns
- Explicit error classes from `error.ts`
- No `any` types - use explicit interfaces
- Absolute imports via `~/*` alias

## Dependencies

### Internal
- `src/routes/` - Route handlers consume these modules
- `src/services/` - Account auth interacts with GitHub services

### External
- `zod` - Runtime validation
- `gpt-tokenizer` - Token counting
- `hono` - HTTP context types
