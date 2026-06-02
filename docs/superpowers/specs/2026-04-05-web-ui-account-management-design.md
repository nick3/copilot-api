# Web UI Account Management — Design Spec

**Date**: 2026-04-05
**Status**: Draft
**Scope**: Add, delete, and re-authenticate GitHub Copilot accounts via Admin UI

## Overview

Enable users to manage GitHub Copilot accounts directly through the Admin Web UI instead of the CLI. The feature uses GitHub's Device Code Flow for authentication, with a REST + polling architecture that aligns with the existing Admin API patterns.

## Requirements

### Functional

1. **Add Account**: Users can add new GitHub Copilot accounts through a multi-step modal dialog
2. **Delete Account**: Users can remove accounts with confirmation
3. **Re-authenticate**: Users can refresh authentication for failed/expired accounts

### Account Types

Three account types are supported (matching `AccountType` in `src/lib/types/account.ts`):

- **Individual** — Personal GitHub Copilot subscription
- **Business** — Organization-managed Copilot Business plan
- **Enterprise** — GitHub Enterprise Server (requires custom domain input)

### Non-functional

- Reuse existing authentication infrastructure (`getDeviceCode`, `pollAccessToken`, etc.)
- Follow existing Admin API security model (`decideAdminAccess`)
- Maintain UI consistency with existing Admin UI (shadcn + Radix + Tailwind + Magic UI)

## Technical Approach: REST + Polling

Device Code Flow is inherently a polling-based protocol (GitHub mandates 5-10s intervals). A REST + polling approach naturally matches this rhythm and keeps the architecture consistent with the existing Admin API (pure REST, no WebSocket/SSE infrastructure needed).

## API Design

### New Endpoints

All endpoints are under `/api/admin/` and protected by the existing `decideAdminAccess` middleware.

#### 1. Start Authentication — `POST /api/admin/accounts/auth/start`

Initiates a GitHub Device Code authentication flow.

**Request:**
```json
{
  "accountType": "individual" | "business" | "enterprise",
  "enterpriseDomain": "github.example.com"  // required for enterprise only
}
```

**Response (200):**
```json
{
  "sessionId": "uuid-v4",
  "userCode": "ABCD-1234",
  "verificationUri": "https://github.com/login/device",
  "expiresIn": 900,
  "interval": 5
}
```

**Backend behavior:**
1. Call `getDeviceCode()` (with enterprise domain override if applicable)
2. Create an in-memory `AuthSession` in `AuthSessionManager`
3. Start background polling via `pollAccessToken()`
4. Return device code info to the frontend

#### 2. Check Status — `GET /api/admin/accounts/auth/status/:sessionId`

Frontend polls this endpoint to check authentication progress.

**Response (200):**
```json
{
  "status": "pending" | "completed" | "failed" | "expired",
  "accountId": "octocat",     // present when completed
  "error": "Token expired"     // present when failed
}
```

**Backend behavior:**
- Read session state from in-memory `Map`
- When `pollAccessToken` succeeds: call `getGitHubUser()` → `saveAccountToken()` → `addAccountToRegistry()` → update status to `completed`
- When device code expires: update status to `expired`

#### 3. Cancel Authentication — `POST /api/admin/accounts/auth/cancel/:sessionId`

Aborts an in-progress authentication flow.

**Response (200):**
```json
{ "cancelled": true }
```

**Backend behavior:** Abort background polling, clean up session.

#### 4. Delete Account — `DELETE /api/admin/accounts/:id`

Removes an account from the registry and deletes its token file.

**Response (200):**
```json
{ "deleted": true, "accountId": "octocat" }
```

**Response (404):** Account not found.

**Backend behavior:** Call `removeAccountFromRegistry(id)` + `removeAccountToken(id)`. The running `accountsManager` auto-detects registry changes via `fs.watch` and removes the account from runtime.

#### 5. Re-authenticate — `POST /api/admin/accounts/:id/reauth`

Re-authenticates an existing account. Account type and enterprise domain are read from the existing registry entry.

**Response (200):** Same format as `auth/start`.

**Backend behavior:** Same as `auth/start`, but on completion updates the existing account's token instead of creating a new registry entry. If the authenticated GitHub user differs from the original account ID, the reauth is rejected with a `failed` status and an error message explaining the mismatch — the user should use "Add Account" instead to add a different account.

### Session Management

- Auth sessions stored in `Map<string, AuthSession>` (in-memory only)
- Each session has a TTL aligned with the device code's `expires_in` (typically 15 minutes)
- Expired sessions are automatically cleaned up via periodic sweep
- Multiple concurrent auth sessions are supported
- Sessions do not survive server restarts (by design — device codes are ephemeral)

## UI Design

### Component Library

The Admin UI uses **shadcn** (Radix + Tailwind + cva) with **Magic UI** components (`MagicCard`, `RainbowButton`, `NumberTicker`, `BentoGrid`, `BorderBeam`, `AnimatedGradientText`, etc.). New components must use these libraries to maintain visual consistency.

### Add Account — Multi-Step Modal Dialog

**Step 1: Select Account Type**
- Three radio-style options: Individual / Business / Enterprise
- Enterprise selection reveals a domain input field
- "Continue" button proceeds to Step 2

**Step 2: GitHub Authorization**
- Displays the `userCode` in a large monospace font with a Copy button
- Automatically opens `verificationUri` in a new browser tab (`window.open()`)
- Shows fallback link if auto-open fails
- Displays polling status with animated indicator: "Waiting for authorization..."
- Shows countdown timer (based on `expiresIn`)
- "Cancel" button aborts the flow
- Frontend polls `GET /auth/status/:sessionId` every `interval` seconds

**Step 3: Success**
- Green checkmark icon
- Account summary card (ID, type, status)
- "Done" button closes dialog and triggers account list refresh

### Account Table Row Actions

Added to the existing accounts table in `accounts-page.tsx`:

- **Reauth button**: Available on all accounts; visually highlighted on `failed` status accounts. Opens Step 2 of the modal (skipping type selection).
- **Delete button**: Red/destructive variant. Opens a confirmation dialog before deletion.

### Delete Confirmation Dialog

Simple dialog: "Are you sure you want to delete account `{id}`? This action cannot be undone." with Cancel and Delete buttons.

## Error Handling

### Authentication Flow

| Scenario | Behavior |
|----------|----------|
| `getDeviceCode()` request fails | Modal shows error message + "Retry" button |
| User doesn't authorize within time limit | Status becomes `expired`, show "Expired" + "Start Over" button |
| User cancels | Call `cancel` endpoint, abort polling, close dialog |
| `pollAccessToken` network error | Backend silently retries (matching CLI behavior), frontend continues showing "waiting" |
| Token obtained but `getGitHubUser()` fails | Status becomes `failed` with error detail |

### Account Management

| Scenario | Behavior |
|----------|----------|
| Duplicate account (same GitHub login) | Backend detects existing registry entry → updates token (equivalent to re-auth), not an error |
| Delete non-existent account | Returns 404, frontend shows toast notification and refreshes list |
| Registry file lock contention | `accounts-registry.ts` has built-in locking; requests queue automatically |

## Security Considerations

- All new endpoints reuse `decideAdminAccess` middleware (localhost-only or ADMIN_TOKEN required)
- Auth sessions are memory-only — no sensitive data persisted beyond existing token storage
- Token files maintain `0o600` permissions (existing behavior)
- GitHub tokens never sent to the frontend — authentication completes entirely server-side
- Device code sessions have bounded lifetimes (max ~15 minutes)

## File Changes

### Backend (New/Modified)

```
src/routes/admin-api/
  ├── route.ts                  (modified — register new endpoints)
  └── auth-sessions.ts          (new — AuthSessionManager class)
```

**`auth-sessions.ts`** encapsulates:
- `AuthSession` type: `{ sessionId, accountType, enterpriseDomain?, status, userCode, verificationUri, expiresAt, accountId?, error?, abortController }`
- `AuthSessionManager` class: `start()`, `getStatus()`, `cancel()`, session cleanup timer
- Reuses: `getDeviceCode()`, `pollAccessToken()`, `getGitHubUser()`, `saveAccountToken()`, `addAccountToRegistry()`, `removeAccountFromRegistry()`, `removeAccountToken()`

### Frontend (New/Modified)

```
admin-ui/src/
  ├── components/
  │   ├── add-account-dialog.tsx     (new — multi-step add account dialog)
  │   └── delete-account-dialog.tsx  (new — delete confirmation dialog)
  ├── lib/
  │   └── admin-api.ts               (modified — add new API functions)
  └── pages/
      └── accounts-page.tsx          (modified — add button + table actions)
```

### Hot Reload

No additional hot-reload mechanism needed. The existing `accountsManager` watches the registry file via `fs.watch`. When the backend API saves a token and updates the registry, the running `accountsManager` automatically detects changes and initializes the new account.
