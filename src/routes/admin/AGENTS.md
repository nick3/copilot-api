<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# admin

## Purpose
Admin UI static file serving. Serves the compiled React admin dashboard built in `admin-ui/`.

## Key Files

| File | Description |
|------|-------------|
| `route.ts` | Serves the compiled admin-ui SPA (single-page application) |

## For AI Agents

### Working In This Directory
- This route serves static assets from `dist/admin/`
- The actual UI code lives in `admin-ui/` directory

## Dependencies

### Internal
- `admin-ui/` - React admin dashboard source
