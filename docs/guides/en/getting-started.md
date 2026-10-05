# Installation and startup

This branch provides a multi-account gateway and the browser-based Admin UI. For installation, Docker volumes and command-line flags, follow the [main README](../../../README.md).

From the repository root:

```sh
bun install --frozen-lockfile
bun install --frozen-lockfile --cwd admin-ui
bun run build
bun run start start
```

The CLI entry is `@nick3/copilot-api`. The package requires Node.js >= 22.18.0; Bun can run the source directly. An empty account registry is supported: open `/admin` to add Copilot accounts. Third-party providers and Codex can be configured independently.

See [configuration](configuration.md) for runtime reload and provider controls, and [API authentication](api.md) before exposing the server on a network.
