<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# pages

## Purpose
Dashboard pages for the admin UI, each representing a major section of the dashboard.

## Key Files

| File | Description |
|------|-------------|
| `accounts-page.tsx` | Account management: list accounts, add/remove, view tokens, auth status |
| `requests-page.tsx` | Request history table with filtering and search |
| `request-detail-page.tsx` | Detailed view of a single request |
| `request-replay-page.tsx` | Request replay: edit body/headers and replay via different account |
| `models-page.tsx` | Model listing and configuration |
| `statistics-page.tsx` | Usage statistics and charts |
| `settings-page.tsx` | Application settings management |
| `not-found-page.tsx` | 404 page |

## For AI Agents

### Working In This Directory
- Pages use `app-shell.tsx` layout wrapper
- Statistics aggregation uses `lib/statistics-local-aggregation.ts`
- Request replay uses `components/replay/*` components
