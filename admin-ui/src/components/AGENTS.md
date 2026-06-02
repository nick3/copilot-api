<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# components

## Purpose
Reusable React components for the admin dashboard, organized by feature area.

## Key Files

| File | Description |
|------|-------------|
| `app-shell.tsx` | Main layout shell with navigation and page structure |
| `add-account-dialog.tsx` | Account addition dialog with device code flow |
| `delete-account-dialog.tsx` | Account deletion confirmation dialog |
| `token-dialog.tsx` | Token view/edit dialog |
| `theme-toggle.tsx` | Dark/light theme toggle |
| `locale-toggle.tsx` | Language switcher (en-US/zh-CN) |
| `motion-toggle.tsx` | Animation preference toggle |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `charts/` | Data visualization components: usage charts, premium usage (see `charts/AGENTS.md`) |
| `json/` | JSON display components (see `json/AGENTS.md`) |
| `replay/` | Request replay UI components (see `replay/AGENTS.md`) |
| `settings/` | Settings page components: navigation, section cards, save button (see `settings/AGENTS.md`) |
| `ui/` | shadcn/ui base components: buttons, dialogs, tables, forms, etc. (see `ui/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- `ui/` contains shadcn/ui primitives - avoid modifying unless adding new variants
- Feature components compose ui primitives
- Chart components use Recharts
