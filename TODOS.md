# TODOS

## Stateful MCP session registry if real clients require it

**What:** Add a stateful MCP session registry for the HTTP `tool_search` bridge if real clients require stable sessions, resumability, or server-initiated notifications.

**Why:** The first Streamable HTTP release intentionally uses stateless per-request `WebStandardStreamableHTTPServerTransport` because the current `search` tool only returns a sentinel and has no server-side session state. SDK support for `sessionIdGenerator`, `onsessioninitialized`, and `onsessionclosed` remains the upgrade path if stateless mode proves insufficient.

**Pros:** Preserves the future architecture path without overbuilding the first release.

**Cons:** Adds no immediate user value until a real remote MCP client needs stable sessions.

**Context:** `/plan-eng-review` for the Streamable HTTP MCP bridge accepted stateless per-request transport after verifying SDK 1.29.0 rejects reused stateless transports. Do not build this until client evidence shows stateless mode is insufficient.

**Depends on / blocked by:** Real Claude Code remote MCP or other MCP client evidence that stateless per-request mode cannot satisfy required behavior.
