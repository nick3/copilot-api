<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# admin-ui

## Purpose
React-based admin dashboard for monitoring and managing the Copilot API proxy. Built with Vite, TypeScript, and shadcn/ui components.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Admin UI dependencies and scripts |
| `vite.config.ts` | Vite build configuration |
| `tsconfig.json` | TypeScript configuration (references app and node configs) |
| `tsconfig.app.json` | App-specific TypeScript settings |
| `tsconfig.node.json` | Node-specific TypeScript settings |
| `eslint.config.js` | ESLint configuration |
| `index.html` | SPA entry HTML |
| `components.json` | shadcn/ui component configuration |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | React application source (see `src/AGENTS.md`) |
| `public/` | Static assets for the SPA (see `public/AGENTS.md`) |
| `tests/` | Admin UI unit tests (see `tests/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Run `bun run --cwd admin-ui build` to build the dashboard
- Run `bun run --cwd admin-ui dev` for development server
- Admin UI is bundled into `dist/admin/` and served by the main server

## Dependencies

### External
- React 18+ with TypeScript
- Vite - build tool
- shadcn/ui - component library
- Recharts - charting
