<!-- Parent: ../../../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# replay

## Purpose
Request replay UI components for the dev mode replay feature. Allows editing request body, headers, and selecting target account.

## Key Files

| File | Description |
|------|-------------|
| `replay-context-card.tsx` | Shows captured request context (original body, headers, response) |
| `replay-body-editor.tsx` | JSON body editor for modifying request payload |
| `replay-headers-editor.tsx` | Headers editor for modifying business headers |
| `replay-account-select.tsx` | Account selector for replay target |
| `replay-response-panel.tsx` | Displays replay response result |

## For AI Agents

### Working In This Directory
- Replay communicates with `/api/admin/replay` endpoints
- Response panel shows translated response from different account

## Dependencies

### Internal
- `admin-ui/src/lib/admin-api.ts` - API client
