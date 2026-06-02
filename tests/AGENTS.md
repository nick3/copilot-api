<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# tests

## Purpose
Test suite for the Copilot API proxy. Covers account management, message handling, route endpoints, translation layers, auth, and utilities.

## Key Files

### Account Management Tests

| File | Description |
|------|-------------|
| `accounts-manager-401.test.ts` | Account 401 handling |
| `accounts-manager-affinity-miss.test.ts` | Affinity miss behavior |
| `accounts-manager-auth.test.ts` | Account authentication flow |
| `accounts-manager-free-lb.test.ts` | Free model round-robin distribution |
| `accounts-manager-quota-scheduler.test.ts` | Background quota refresh scheduler |
| `accounts-manager-reservation.test.ts` | Quota reservation system |
| `accounts-manager-session-affinity.test.ts` | Session-based account affinity |
| `accounts-registry.test.ts` | Account persistence layer |
| `account-affinity-cache.test.ts` | Affinity caching |
| `account-client-identity.test.ts` | Client identity per account |
| `account-enable-disable.test.ts` | Account enable/disable toggle |
| `account-type.test.ts` | Account type handling |

### Message Handler Tests

| File | Description |
|------|-------------|
| `messages-handler.test.ts` | Main message handler |
| `messages-handler-compact.test.ts` | Compact request handling |
| `messages-preprocess.test.ts` | Request preprocessing |
| `messages-preprocess-pdf-attachments.test.ts` | PDF attachment handling |
| `messages-model-alias.test.ts` | Model alias switching |
| `messages-request-log-subagent.test.ts` | Subagent request logging |

### Route Tests

| File | Description |
|------|-------------|
| `chat-completions-handler.test.ts` | Chat completions handler |
| `chat-completions-session-id.test.ts` | Session ID in chat completions |
| `responses-translation.test.ts` | Responses translation layer |
| `responses-stream-translation.test.ts` | Streaming responses translation |
| `responses-remove-unsupported-tools.test.ts` | Unsupported tool filtering |
| `responses-request-log-prompt-cache-key.test.ts` | Prompt cache key logging |
| `embeddings-route.test.ts` | Embeddings endpoint |
| `models-route.test.ts` | Models endpoint |
| `admin-config.test.ts` | Admin configuration endpoints |
| `admin-api-dev-mode.test.ts` | Dev mode API |
| `admin-api-outbound.test.ts` | Outbound capture API |
| `admin-db-migrations.test.ts` | Database migrations |
| `admin-models-details.test.ts` | Admin model details |
| `admin-account-auth-enterprise-cloud.test.ts` | Enterprise cloud auth in admin |

### Translation and Service Tests

| File | Description |
|------|-------------|
| `create-messages.test.ts` | Messages service client |
| `create-responses.test.ts` | Responses service client |
| `create-chat-completions.test.ts` | Chat completions service client |
| `copilot-fetch.test.ts` | Copilot HTTP client |
| `copilot-rate-limit.test.ts` | Rate limit tracking |
| `anthropic-request.test.ts` | Anthropic request parsing |
| `anthropic-response.test.ts` | Anthropic response handling |

### Auth and Security Tests

| File | Description |
|------|-------------|
| `request-auth.test.ts` | Request auth handling |
| `api-key-auth.test.ts` | API key auth middleware |
| `provider-auth.test.ts` | Provider auth |
| `token-refresh.test.ts` | Token refresh flow |

### Utility Tests

| File | Description |
|------|-------------|
| `utils.test.ts` | General utilities |
| `error.test.ts` | Error classes |
| `logger.test.ts` | Logging setup |
| `api-config.test.ts` | API config |
| `handler-utils.test.ts` | Handler utilities |
| `trace.test.ts` | Trace ID middleware |
| `deviceid.test.ts` | Device ID generation |
| `compact-request.test.ts` | Compact request detection |
| `dev-mode-config.test.ts` | Dev mode config |
| `subagent-marker.test.ts` | Subagent marker detection |
| `strip-cache-control.test.ts` | Cache control stripping |

### Replay and Dev Mode Tests

| File | Description |
|------|-------------|
| `replay-handler.test.ts` | Replay endpoint |
| `replay-stream.test.ts` | Replay streaming |
| `request-outbound-store.test.ts` | Outbound request storage |
| `outbound-redaction.test.ts` | Outbound data redaction |

### Other Tests

| File | Description |
|------|-------------|
| `warmup-probe.test.ts` | Warmup probe handling |
| `model-source-account-manager.test.ts` | Model source routing |
| `model-alias-switch.test.ts` | Model alias switching |
| `request-initiator.test.ts` | Request initiator tracking |
| `stats-store.test.ts` | Statistics store |
| `stream-error-events.test.ts` | Stream error event handling |
| `unexpected-stream-hardening.test.ts` | Unexpected stream error handling |
| `message-start-input-tokens-fallback.test.ts` | Input token fallback |
| `session-affinity-store.test.ts` | Session affinity store |
| `session-ownership-cache.test.ts` | Session ownership cache |
| `main-cli-global-options.test.ts` | CLI global options |

### Test Utilities

| File | Description |
|------|-------------|
| `accounts-manager-test-helpers.ts` | Shared test helpers for accounts manager |
| `shared-admin-db-test-home.ts` | Shared admin DB test home directory |

## For AI Agents

### Working In This Directory
- Use `bun test` to run all tests
- Use `bun test tests/filename.test.ts` for single file
- Test files should match source files they test
- Follow existing naming: `<source-file>.test.ts`
