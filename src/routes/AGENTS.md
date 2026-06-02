<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# routes

## Purpose
HTTP route handlers for all API endpoints. Organized by API surface: OpenAI-compatible, Anthropic-compatible, Copilot-native, admin, and provider-specific routes.

## Key Files

| File | Description |
|------|-------------|
| `models/route.ts` | `/v1/models` endpoint - returns available model list |
| `token/route.ts` | Token-related endpoint |
| `usage/route.ts` | Usage reporting endpoint |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `admin/` | Admin UI static file serving (see `admin/AGENTS.md`) |
| `admin-api/` | Admin API endpoints: config, accounts, replay, auth sessions (see `admin-api/AGENTS.md`) |
| `chat-completions/` | OpenAI-compatible `/v1/chat/completions` (see `chat-completions/AGENTS.md`) |
| `embeddings/` | Embedding endpoint (see `embeddings/AGENTS.md`) |
| `messages/` | Anthropic-compatible `/v1/messages` - primary request orchestration (see `messages/AGENTS.md`) |
| `provider/` | Provider-specific endpoints: alternative messages/models routes (see `provider/AGENTS.md`) |
| `responses/` | Copilot-native `/v1/responses` (see `responses/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Each subdirectory represents an API surface area
- Route files typically export handlers for Hono router
- The `/v1/messages` flow is the most complex (see `messages/handler.ts`)
- Account selection happens per-request via `accountsManager.selectAccountForRequest()`

## Dependencies

### Internal
- `src/lib/` - Account management, config, error handling
- `src/services/` - Copilot and GitHub API clients

### External
- `hono` - HTTP routing framework
- `undici` - HTTP client for upstream calls
