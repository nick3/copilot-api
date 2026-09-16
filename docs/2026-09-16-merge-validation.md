# caozhiyuan v2.6.1 merge validation

Date: 2026-09-16. This records the implementation and local validation of the approved [functional merge plan](2026-09-16-caozhiyuan-v2.6.1-merge-analysis.md). Deployment changes and configuration examples are documented in the [upgrade guide](merge-v2.6.1-upgrade.md).

## Summary

The merge integrates common functionality from upstream `1c48460142a484d31fa56e79fa60a96d39ddd54e` into `all` at `ae80fe66794999f1bb52049ea5cda0a5da6766d6`. The comparison base is `590bc1473e224dbb2d588d3cfb475f823de3ad74`. The existing merge was completed in place after backing up its index, merge metadata and working files.

The implementation preserves Copilot account scheduling, account and session ownership, quota settlement, capture/replay, Admin UI and HTTP MCP. Electron, desktop distribution and the retired usage viewer are excluded.

## Implemented adaptations

- Copilot token API endpoints are bound to each account and guarded by authentication snapshots. Usage refresh cannot overwrite the endpoint associated with the current token.
- HTTP and Responses WebSocket timeouts, bounded buffering and stream cleanup preserve injectable fetch, recording, account affinity and bridge invalidation. Requests cancelled before dispatch are not sent; disconnects after dispatch allow bounded upstream completion and settlement.
- Protocol translation, custom tools, reasoning, caching, provider routing, model catalogs, images and search incorporate the final upstream behavior while retaining all-specific model aliases, explicit capability overrides and reasoning precedence.
- Codex supports up to three stored accounts with one active account, atomic credential updates and guarded refresh. CLI account management is included. A visual Codex account-management page remains a separate follow-up, as proposed in the approved plan.
- Admin configuration supports the new transport, provider authentication, reasoning and pricing fields. Admin and API usage statistics share six periods, with compatibility aliases for existing callers.
- Config writes share atomic persistence and reject unreadable or corrupt files. Gateway key management, explicit host binding and removal of `/token` are included while preserving independent `ADMIN_TOKEN` authentication.
- Container and build definitions retain Admin assets and all-specific persistent data. The package identity and version remain `@nick3/copilot-api` and `1.14.22`; this merge does not publish a release.

The native Copilot WebSocket pool now uses the shared transport implementation. The adapter retains the original pool-key inputs and idle-close notification contract; targeted tests cover account/session isolation, concurrent connections, idle invalidation, pre-dispatch cancellation and bounded buffering.

## Context Checked

The review compared both fixed branch snapshots, the original conflict stages, automatic merge results and relevant configuration, transport, route, account, credential and Admin call sites. It also checked build/release definitions, lockfile changes and the deployment documentation. No live upstream credentials or production configuration were used for validation.

## CHANGESET_SUMMARY

Integrate upstream common API, transport, provider, credential, statistics and persistence improvements into the multi-account gateway. Preserve Admin UI, account routing, capture/replay and existing configuration semantics. Add matching Admin controls and statistics periods, retain separate management authentication, and document host-binding and container migration changes. Exclude Electron and desktop-only distribution. Complete the existing two-parent merge rather than creating an ancestry-only merge.

## CODE_REVIEW_SUMMARY

```text
Review Decision: NON_BLOCKING
Findings Total: 0 (CRITICAL=0, HIGH_PRIORITY=0, REFERENCE=0)

[CRITICAL]
None

[HIGH_PRIORITY]
None

[REFERENCE]
None
```

This is a self-review of the merged implementation. Validation limits below remain relevant to deployment.

## Test Notes

Tests used Bun 1.3.14, temporary data directories and an in-memory usage database. The existing service configuration and accounts were not changed.

| Check | Result |
| --- | --- |
| Root `bun test --isolate --timeout 15000 --coverage --coverage-reporter=lcov` | 1,335 passed, 0 failed, 129 files, 4,830 assertions |
| Admin `bun test --isolate --coverage --coverage-reporter=lcov` | 106 passed, 0 failed, 18 files, 241 assertions |
| `bun run lint:all` | Passed |
| `bun run lint:admin` | Passed |
| `bun run typecheck` | Passed |
| `bun run build` | Passed; includes backend bundle, Admin TypeScript build and Vite build |
| `sh -n entrypoint.sh` | Passed |
| `git diff --check` and conflict-marker inspection | Passed |

Combined root and Admin LCOV data covered **3,565 of 4,106 changed executable lines (86.82%)** relative to the pre-merge `all` commit. This measures changed lines identified as executable by LCOV, including newly added source files; it is not whole-project coverage. CLI child-process executions are tested but are not included in the parent process's coverage data.

A temporary local server was also checked in a browser: invalid transport values were rejected, valid configuration survived save and reload, all six usage periods were available, and the empty lifetime view rendered correctly. The temporary browser tab and server were closed after verification.

The build reports an Admin chunk larger than Vite's 500 kB warning threshold; the build succeeds. Docker is unavailable on the validation host, so no container image build, Compose startup or volume-permission runtime check was performed. Live Copilot, Codex and Azure requests were not exercised; automated tests use controlled upstream responses.

## Release Risk

Medium. This is a broad upstream integration with intentional deployment changes: the CLI defaults to loopback, network listeners require gateway keys, `/token` is removed, and containers run without root. These changes are documented and covered by local tests where possible. Container startup and real-account smoke tests remain deployment checks. No push, package publication or deployment is part of this merge.
