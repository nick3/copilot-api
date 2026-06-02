<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# provider

## Purpose
Provider-specific alternative endpoints for messages and models. These routes provide direct access to underlying provider APIs (Anthropic, OpenAI) rather than the Copilot-abstracted versions.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `messages/` | Provider-specific message endpoints (see `messages/AGENTS.md`) |
| `models/` | Provider-specific model listing (see `models/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Provider routes bypass Copilot and hit provider APIs directly
- Useful for testing provider-specific behavior
