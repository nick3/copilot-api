<!-- Parent: ../../../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# settings

## Purpose
Settings page components for configuring application preferences.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel export for settings components |
| `settings-navigation.tsx` | Settings section navigation sidebar |
| `settings-section-card.tsx` | Reusable settings section card layout |
| `floating-save-button.tsx` | Floating save button that appears when settings are dirty |

## For AI Agents

### Working In This Directory
- Settings are saved via `/api/admin/config` endpoint
- Changes are staged and batch-saved with the floating save button
