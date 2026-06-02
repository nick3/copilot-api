<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# copilot

## Purpose
Copilot API service clients for all supported endpoints: chat completions, messages, responses, embeddings, and models.

## Key Files

| File | Description |
|------|-------------|
| `copilot-fetch.ts` | Low-level HTTP client with retry, rate-limit, and 4xx capture logic |
| `create-chat-completions.ts` | Chat completions API client |
| `create-messages.ts` | Messages API client, accepts `AccountContext` |
| `create-responses.ts` | Responses API client |
| `create-embeddings.ts` | Embeddings API client |
| `get-models.ts` | Model listing API client |

## For AI Agents

### Working In This Directory
- `create-messages.ts` accepts `createMessages(payload, account?, options?)` with `AccountContext`
- `copilot-fetch.ts` tee-captures 4xx responses when `devMode.capture4xx` is enabled
- All functions should accept account context rather than using global state

## Dependencies

### Internal
- `src/lib/` - Account types, config, proxy, error handling
- `src/services/get-vscode-version.ts` - VSCode version header
