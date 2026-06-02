<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-02 | Updated: 2026-05-02 -->

# lib (admin-ui)

## Purpose
Admin UI utility modules for API communication, data formatting, internationalization, statistics, and user preferences.

## Key Files

| File | Description |
|------|-------------|
| `admin-api.ts` | API client for all admin endpoints |
| `admin-token.tsx` | Admin API token management (provider/HOC) |
| `account-auth.ts` | Account authentication flow helpers |
| `accounts-export.ts` | Account data export utilities |
| `chart-format.ts` | Data formatting for Recharts visualization |
| `clipboard.ts` | Clipboard copy utilities |
| `format.ts` | General formatting helpers (numbers, durations) |
| `i18n.ts` | Internationalization setup (en-US, zh-CN) |
| `locale-preference.tsx` | Locale preference provider |
| `motion-preference.tsx` | Animation preference provider |
| `use-prefers-reduced-motion.ts` | Reduced motion detection hook |
| `requests-time-range.ts` | Request time range filtering |
| `statistics-local-aggregation.ts` | Client-side statistics aggregation |
| `statistics-range.ts` | Statistics range computation |
| `sse.ts` | Server-Sent Events client for real-time updates |
| `utils.ts` | General UI utilities (class names, etc.) |

## Dependencies

### Internal
- Admin server API at `/api/admin/*`

### External
- `recharts` - Charting (for `chart-format.ts`)
