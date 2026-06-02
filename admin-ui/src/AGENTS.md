<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# src (admin-ui)

## Purpose
React application source for the admin dashboard. Contains pages for account management, request monitoring, usage statistics, settings, and request replay.

## Key Files

| File | Description |
|------|-------------|
| `App.tsx` | Root component with routing and layout |
| `main.tsx` | Application entry point, React DOM mount |
| `index.css` | Global styles |
| `App.css` | App-specific styles |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `pages/` | Dashboard pages: accounts, requests, models, statistics, settings, replay (see `pages/AGENTS.md`) |
| `components/` | Reusable UI components (see `components/AGENTS.md`) |
| `hooks/` | Custom React hooks (see `hooks/AGENTS.md`) |
| `lib/` | Admin-specific utilities: API client, formatting, i18n, SSE, statistics (see `lib/AGENTS.md`) |
| `locales/` | i18n localization files (en-US, zh-CN) (see `locales/AGENTS.md`) |
| `assets/` | Static assets (images, icons) (see `assets/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Uses shadcn/ui component patterns
- API calls go through `lib/admin-api.ts`
- Internationalization via `lib/i18n.ts` with en-US and zh-CN locales
- SSE for real-time updates

## Dependencies

### Internal
- Main server API at `/api/admin/*` endpoints

### External
- React, React Router
- shadcn/ui components
- Recharts for data visualization
