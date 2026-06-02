<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# github

## Purpose
GitHub authentication services implementing the device code OAuth flow for Copilot account authorization.

## Key Files

| File | Description |
|------|-------------|
| `get-device-code.ts` | Initiates device code flow, returns user verification URI and code |
| `poll-access-token.ts` | Polls GitHub for access token after user authorizes device code |
| `get-copilot-token.ts` | Exchanges GitHub token for Copilot API token |
| `get-user.ts` | Fetches authenticated user information from GitHub |
| `get-copilot-usage.ts` | Retrieves Copilot usage statistics |

## For AI Agents

### Working In This Directory
- Device code flow: `get-device-code` → user authorizes → `poll-access-token` → `get-copilot-token`
- Token refresh is handled by `accounts-manager-auth.ts` using these services

## Dependencies

### Internal
- `src/lib/` - Config, error handling, proxy settings

### External
- `undici` / `srvx` - HTTP client
