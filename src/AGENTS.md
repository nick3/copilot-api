<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# src

## Purpose
Application source code for the Copilot API proxy server. Contains all CLI entry points, HTTP server setup, core business logic, route handlers, and external service integrations.

## Key Files

| File | Description |
|------|-------------|
| `main.ts` | CLI entry point using `citty` with `start`, `auth`, `check-usage`, `debug` subcommands |
| `start.ts` | Server initialization, account setup, auth flow orchestration |
| `server.ts` | Hono HTTP server setup with middleware and route registration |
| `auth.ts` | GitHub device code authentication flow |
| `check-usage.ts` | CLI command for checking account quota usage |
| `debug.ts` | CLI debug command for troubleshooting |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `lib/` | Core business logic: account management, config, error handling, rate limiting, session affinity, quota reservation (see `lib/AGENTS.md`) |
| `routes/` | HTTP route handlers for all API endpoints (see `routes/AGENTS.md`) |
| `services/` | External API integrations with Copilot and GitHub services (see `services/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Entry points are `main.ts` (CLI) and `server.ts` (HTTP)
- Server initialization flows through `start.ts` → `server.ts` → route registration
- Use `~/*` path alias for imports from `src/`

### Testing Requirements
- Changes to entry points should be tested via integration tests in `tests/`
- CLI commands tested via `tests/main-cli-global-options.test.ts`

### Common Patterns
- ES modules only, no CommonJS
- Strict TypeScript with explicit types
- Barrel exports not used at this level

## Dependencies

### Internal
- `lib/` - Core business logic
- `routes/` - HTTP handlers
- `services/` - External service clients

### External
- `citty` - CLI framework
- `hono` - HTTP server
- `consola` - Logging
- `srvx` - Fetch wrapper
- `undici` - HTTP client
