<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# claude-plugin

## Purpose
Claude Code plugin configuration and automation hooks for this project.

## Key Files

| File | Description |
|------|-------------|
| `.claude-plugin/plugin.json` | Plugin manifest and metadata |
| `hooks/hooks.json` | Hook configuration for Claude Code |
| `scripts/subagent-start-marker.js` | Subagent lifecycle marker script |
| `scripts/session-start-rules.js` | Session startup rules script |
| `scripts/user-prompt-submit-reminder.js` | User prompt submission reminder |

## For AI Agents

### Working In This Directory
- Hook scripts are executed by Claude Code at specific lifecycle events
- `plugin.json` defines plugin identity and capabilities
