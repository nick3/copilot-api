<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# services

## Purpose
External API integration layer. Contains clients for Copilot API endpoints (chat-completions, messages, responses, embeddings, models), GitHub authentication (device code flow, token polling), and Anthropic proxy integration.

## Key Files

| File | Description |
|------|-------------|
| `get-vscode-version.ts` | Fetches latest VSCode version for Copilot API headers |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `copilot/` | Copilot API service clients for all supported endpoints (see `copilot/AGENTS.md`) |
| `github/` | GitHub authentication services: device code, token polling, user info (see `github/AGENTS.md`) |
| `providers/` | Provider-specific integrations (see `providers/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Functions accept `AccountContext` rather than assuming global single-account state
- `copilot-fetch.ts` is the low-level HTTP client with retry/rate-limit logic
- All service functions should use explicit error types

## Dependencies

### Internal
- `src/lib/` - Account context, config, error types, proxy settings

### External
- `undici` - HTTP client
- `srvx` - Fetch wrapper with proxy support
