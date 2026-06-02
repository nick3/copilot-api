# Web UI Account Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable adding, deleting, and re-authenticating GitHub Copilot accounts through the Admin Web UI using Device Code Flow.

**Architecture:** REST + polling backend with in-memory auth session management. Frontend uses a multi-step modal dialog built with shadcn/Radix components. The existing `accountsManager` hot-reload (via `fs.watch`) handles runtime integration automatically.

**Tech Stack:** Hono (backend routes), React + shadcn + Radix + Tailwind + Magic UI (frontend), Bun test runner

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/routes/admin-api/auth-sessions.ts` | `AuthSessionManager` class — manages in-memory auth sessions, orchestrates device code flow |
| `admin-ui/src/components/add-account-dialog.tsx` | Multi-step modal dialog for adding accounts (type select → authorize → success) |
| `admin-ui/src/components/delete-account-dialog.tsx` | Confirmation dialog for account deletion |
| `tests/admin-api-auth-sessions.test.ts` | Unit tests for `AuthSessionManager` |

### Modified Files

| File | Changes |
|------|---------|
| `src/services/github/get-device-code.ts` | Add optional `overrideUrls` parameter for enterprise support |
| `src/services/github/poll-access-token.ts` | Add optional `overrideUrls` parameter + `AbortSignal` support |
| `src/routes/admin-api/route.ts` | Register 5 new endpoints (auth/start, auth/status, auth/cancel, accounts/:id DELETE, accounts/:id/reauth) |
| `admin-ui/src/lib/admin-api.ts` | Add API functions for new endpoints |
| `admin-ui/src/pages/accounts-page.tsx` | Add "Add Account" button + row action buttons (Reauth, Delete) |
| `admin-ui/src/locales/en-US.json` | Add i18n strings for new UI elements |
| `admin-ui/src/locales/zh-CN.json` | Add i18n strings for new UI elements |

---

## Task 1: Extend Device Code functions with optional URL overrides

Enable `getDeviceCode()` and `pollAccessToken()` to accept custom OAuth URLs for enterprise domain support, and add `AbortSignal` support to `pollAccessToken()` for cancellation.

**Files:**
- Modify: `src/services/github/get-device-code.ts`
- Modify: `src/services/github/poll-access-token.ts`
- Test: `tests/admin-api-auth-sessions.test.ts` (tested indirectly via Task 2)

- [ ] **Step 1: Add overrideUrls parameter to getDeviceCode**

```ts
// src/services/github/get-device-code.ts
import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface DeviceCodeOptions {
  overrideUrls?: {
    deviceCodeUrl: string
    accessTokenUrl: string
  }
}

export async function getDeviceCode(
  options?: DeviceCodeOptions,
): Promise<DeviceCodeResponse> {
  const { clientId, headers, scope } = getOauthAppConfig()
  const { deviceCodeUrl } = options?.overrideUrls ?? getOauthUrls()

  const response = await fetch(deviceCodeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      client_id: clientId,
      scope,
    }),
  })

  if (!response.ok) throw new HTTPError("Failed to get device code", response)

  return (await response.json()) as DeviceCodeResponse
}
```

- [ ] **Step 2: Add overrideUrls and AbortSignal to pollAccessToken**

```ts
// src/services/github/poll-access-token.ts
import consola from "consola"

import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import { sleep } from "~/lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

export interface PollAccessTokenOptions {
  overrideUrls?: {
    deviceCodeUrl: string
    accessTokenUrl: string
  }
  signal?: AbortSignal
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
  options?: PollAccessTokenOptions,
): Promise<string> {
  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = options?.overrideUrls ?? getOauthUrls()

  const sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

  while (true) {
    if (options?.signal?.aborted) {
      throw new Error("Authentication cancelled")
    }

    const response = await fetch(accessTokenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: options?.signal,
    })

    if (!response.ok) {
      await sleep(sleepDuration)
      consola.error("Failed to poll access token:", await response.text())
      continue
    }

    const json = await response.json()
    consola.debug("Polling access token response:", json)

    const { access_token } = json as { access_token: string }

    if (access_token) {
      return access_token
    } else {
      await sleep(sleepDuration)
    }
  }
}
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `bun test`
Expected: All existing tests pass (no breaking changes since the new params are optional).

- [ ] **Step 4: Commit**

```bash
git add src/services/github/get-device-code.ts src/services/github/poll-access-token.ts
git commit -m "feat: add optional URL overrides and AbortSignal to device code functions"
```

---

## Task 2: Create AuthSessionManager

Implement the in-memory session manager that orchestrates the device code auth flow for the Web UI.

**Files:**
- Create: `src/routes/admin-api/auth-sessions.ts`
- Test: `tests/admin-api-auth-sessions.test.ts`

- [ ] **Step 1: Create AuthSessionManager**

```ts
// src/routes/admin-api/auth-sessions.ts
import { randomUUID } from "node:crypto"
import consola from "consola"

import {
  addAccountToRegistry,
  listAccountsFromRegistry,
  loadRegistry,
  saveAccountToken,
  saveRegistry,
} from "~/lib/accounts-registry"
import { normalizeDomain } from "~/lib/api-config"
import { ensurePaths } from "~/lib/paths"
import type { AccountType } from "~/lib/types/account"
import { getDeviceCode, type DeviceCodeResponse } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

export type AuthSessionStatus = "pending" | "completed" | "failed" | "expired"

export interface AuthSession {
  sessionId: string
  accountType: AccountType
  enterpriseDomain: string | null
  status: AuthSessionStatus
  userCode: string
  verificationUri: string
  expiresAt: number
  interval: number
  accountId?: string
  error?: string
  abortController: AbortController
  /** The account ID being re-authenticated (null for new accounts) */
  reauthAccountId: string | null
}

export interface StartAuthResult {
  sessionId: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

function buildOauthUrls(enterpriseDomain: string | null) {
  if (!enterpriseDomain) return undefined
  const domain = normalizeDomain(enterpriseDomain)
  if (!domain) return undefined
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  }
}

const CLEANUP_INTERVAL_MS = 60_000

export class AuthSessionManager {
  private sessions = new Map<string, AuthSession>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS)
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    for (const session of this.sessions.values()) {
      session.abortController.abort()
    }
    this.sessions.clear()
  }

  async startAuth(params: {
    accountType: AccountType
    enterpriseDomain?: string
    reauthAccountId?: string
  }): Promise<StartAuthResult> {
    const enterpriseDomain = params.enterpriseDomain
      ? normalizeDomain(params.enterpriseDomain)
      : null

    const overrideUrls = buildOauthUrls(enterpriseDomain)

    await ensurePaths()
    const deviceResponse = await getDeviceCode({ overrideUrls })

    const sessionId = randomUUID()
    const abortController = new AbortController()
    const expiresAt = Date.now() + deviceResponse.expires_in * 1000

    const session: AuthSession = {
      sessionId,
      accountType: params.accountType,
      enterpriseDomain,
      status: "pending",
      userCode: deviceResponse.user_code,
      verificationUri: deviceResponse.verification_uri,
      expiresAt,
      interval: deviceResponse.interval,
      abortController,
      reauthAccountId: params.reauthAccountId ?? null,
    }

    this.sessions.set(sessionId, session)

    // Start background polling (fire and forget)
    void this.runAuthFlow(session, deviceResponse, overrideUrls)

    return {
      sessionId,
      userCode: deviceResponse.user_code,
      verificationUri: deviceResponse.verification_uri,
      expiresIn: deviceResponse.expires_in,
      interval: deviceResponse.interval,
    }
  }

  getStatus(sessionId: string): {
    status: AuthSessionStatus
    accountId?: string
    error?: string
  } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    // Check if expired
    if (session.status === "pending" && Date.now() >= session.expiresAt) {
      session.status = "expired"
      session.abortController.abort()
    }

    return {
      status: session.status,
      accountId: session.accountId,
      error: session.error,
    }
  }

  cancel(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    session.abortController.abort()
    this.sessions.delete(sessionId)
    return true
  }

  private async runAuthFlow(
    session: AuthSession,
    deviceResponse: DeviceCodeResponse,
    overrideUrls: ReturnType<typeof buildOauthUrls>,
  ): Promise<void> {
    try {
      const token = await pollAccessToken(deviceResponse, {
        overrideUrls,
        signal: session.abortController.signal,
      })

      const user = await getGitHubUser({
        githubToken: token,
        accountType: session.accountType,
      })

      const accountId = user.login

      // For reauth: check if the authenticated user matches
      if (session.reauthAccountId && session.reauthAccountId !== accountId) {
        session.status = "failed"
        session.error = `Authenticated as "${accountId}" but expected "${session.reauthAccountId}". Use "Add Account" to add a different account.`
        return
      }

      // Save token
      await saveAccountToken(accountId, token)

      // Check if account already exists in registry
      const existingAccounts = await listAccountsFromRegistry()
      const alreadyExists = existingAccounts.some((acc) => acc.id === accountId)

      if (alreadyExists) {
        // Touch registry to trigger hot-reload
        await saveRegistry(await loadRegistry())
      } else {
        await addAccountToRegistry({
          id: accountId,
          accountType: session.accountType,
          addedAt: Date.now(),
        })
      }

      session.status = "completed"
      session.accountId = accountId
    } catch (error) {
      if (session.abortController.signal.aborted) {
        // Cancelled — don't update status (session may already be removed)
        return
      }

      session.status = "failed"
      session.error = error instanceof Error ? error.message : String(error)
      consola.error(`Auth session ${session.sessionId} failed:`, error)
    }
  }

  private cleanupExpired(): void {
    const now = Date.now()
    // Clean up sessions that expired more than 5 minutes ago
    const cleanupThreshold = 5 * 60_000

    for (const [id, session] of this.sessions) {
      if (session.status !== "pending" && now - session.expiresAt > cleanupThreshold) {
        session.abortController.abort()
        this.sessions.delete(id)
      }
      if (session.status === "pending" && now >= session.expiresAt) {
        session.status = "expired"
        session.abortController.abort()
      }
    }
  }
}

export const authSessionManager = new AuthSessionManager()
```

- [ ] **Step 2: Verify the module compiles**

Run: `bun run typecheck`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin-api/auth-sessions.ts
git commit -m "feat: add AuthSessionManager for web UI account auth"
```

---

## Task 3: Register backend API endpoints

Wire the 5 new endpoints into the existing admin API router.

**Files:**
- Modify: `src/routes/admin-api/route.ts`

- [ ] **Step 1: Import AuthSessionManager and account registry functions**

At the top of `src/routes/admin-api/route.ts`, add imports:

```ts
import {
  removeAccountFromRegistry,
  removeAccountToken,
  listAccountsFromRegistry,
  getAccountClientIdentity,
} from "~/lib/accounts-registry"
import {
  isAccountType,
  type AccountType,
} from "~/lib/types/account"
import { authSessionManager } from "./auth-sessions"
```

Note: `listAccountsFromRegistry` is already imported. Only add `removeAccountFromRegistry`, `removeAccountToken`, `getAccountClientIdentity`, `isAccountType`, `AccountType`, and `authSessionManager`.

- [ ] **Step 2: Add POST /accounts/auth/start endpoint**

Add before the closing of adminApiRoutes (after the existing `/requests/:requestId` route):

```ts
adminApiRoutes.post("/accounts/auth/start", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return jsonError(c, 400, {
      message: "Request body must be valid JSON.",
      type: "bad_request",
    })
  }

  if (!isPlainObject(payload)) {
    return jsonError(c, 400, {
      message: "Request body must be an object.",
      type: "bad_request",
    })
  }

  const accountType = payload.accountType
  if (!isAccountType(accountType)) {
    return jsonError(c, 400, {
      message: "accountType must be one of: individual, business, enterprise",
      type: "bad_request",
    })
  }

  const enterpriseDomain =
    typeof payload.enterpriseDomain === "string"
      ? payload.enterpriseDomain.trim()
      : undefined

  if (accountType === "enterprise" && !enterpriseDomain) {
    return jsonError(c, 400, {
      message: "enterpriseDomain is required for enterprise accounts.",
      type: "bad_request",
    })
  }

  try {
    const result = await authSessionManager.startAuth({
      accountType,
      enterpriseDomain,
    })
    return c.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return jsonError(c, 500, {
      message: `Failed to start auth: ${msg}`,
      type: "internal_error",
    })
  }
})
```

- [ ] **Step 3: Add GET /accounts/auth/status/:sessionId endpoint**

```ts
adminApiRoutes.get("/accounts/auth/status/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId")
  const status = authSessionManager.getStatus(sessionId)

  if (!status) {
    return c.json(
      { error: { message: "Session not found.", type: "not_found" } },
      404,
    )
  }

  return c.json(status)
})
```

- [ ] **Step 4: Add POST /accounts/auth/cancel/:sessionId endpoint**

```ts
adminApiRoutes.post("/accounts/auth/cancel/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId")
  const cancelled = authSessionManager.cancel(sessionId)

  if (!cancelled) {
    return c.json(
      { error: { message: "Session not found.", type: "not_found" } },
      404,
    )
  }

  return c.json({ cancelled: true })
})
```

- [ ] **Step 5: Add DELETE /accounts/:id endpoint**

```ts
adminApiRoutes.delete("/accounts/:id", async (c) => {
  const accountId = c.req.param("id")

  try {
    const accounts = await listAccountsFromRegistry()
    const exists = accounts.some((a) => a.id === accountId)

    if (!exists) {
      return c.json(
        { error: { message: "Account not found.", type: "not_found" } },
        404,
      )
    }

    await removeAccountToken(accountId)
    await removeAccountFromRegistry(accountId)

    return c.json({ deleted: true, accountId })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return jsonError(c, 500, {
      message: `Failed to delete account: ${msg}`,
      type: "internal_error",
    })
  }
})
```

- [ ] **Step 6: Add POST /accounts/:id/reauth endpoint**

```ts
adminApiRoutes.post("/accounts/:id/reauth", async (c) => {
  const accountId = c.req.param("id")

  try {
    const accounts = await listAccountsFromRegistry()
    const account = accounts.find((a) => a.id === accountId)

    if (!account) {
      return c.json(
        { error: { message: "Account not found.", type: "not_found" } },
        404,
      )
    }

    // Read enterprise domain from the account's client identity
    const clientIdentity = await getAccountClientIdentity(accountId)
    const enterpriseDomain = clientIdentity?.enterpriseDomain ?? undefined

    const result = await authSessionManager.startAuth({
      accountType: account.accountType,
      enterpriseDomain,
      reauthAccountId: accountId,
    })

    return c.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return jsonError(c, 500, {
      message: `Failed to start reauth: ${msg}`,
      type: "internal_error",
    })
  }
})
```

- [ ] **Step 7: Start AuthSessionManager in server initialization**

In `src/routes/admin-api/route.ts`, after the `adminApiRoutes` definition (after the middleware), add:

```ts
// Start auth session cleanup timer
authSessionManager.start()
```

- [ ] **Step 8: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No type errors.

- [ ] **Step 9: Commit**

```bash
git add src/routes/admin-api/route.ts
git commit -m "feat: add admin API endpoints for account auth, delete, and reauth"
```

---

## Task 4: Add frontend API functions

Add the client-side API functions for the new backend endpoints.

**Files:**
- Modify: `admin-ui/src/lib/admin-api.ts`

- [ ] **Step 1: Add types and API functions**

Add at the end of `admin-ui/src/lib/admin-api.ts`:

```ts
// --- Account Management Types ---

export type AccountType = "individual" | "business" | "enterprise"

export type AuthStartRequest = {
  accountType: AccountType
  enterpriseDomain?: string
}

export type AuthStartResponse = {
  sessionId: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type AuthStatusResponse = {
  status: "pending" | "completed" | "failed" | "expired"
  accountId?: string
  error?: string
}

// --- Account Management API Functions ---

export async function startAccountAuth(
  params: AuthStartRequest,
): Promise<AuthStartResponse> {
  return fetchAdminJson<AuthStartResponse>("/api/admin/accounts/auth/start", {
    method: "POST",
    body: JSON.stringify(params),
  })
}

export async function getAuthStatus(
  sessionId: string,
): Promise<AuthStatusResponse> {
  return fetchAdminJson<AuthStatusResponse>(
    `/api/admin/accounts/auth/status/${encodeURIComponent(sessionId)}`,
  )
}

export async function cancelAuth(
  sessionId: string,
): Promise<{ cancelled: boolean }> {
  return fetchAdminJson<{ cancelled: boolean }>(
    `/api/admin/accounts/auth/cancel/${encodeURIComponent(sessionId)}`,
    { method: "POST" },
  )
}

export async function deleteAccount(
  accountId: string,
): Promise<{ deleted: boolean; accountId: string }> {
  return fetchAdminJson<{ deleted: boolean; accountId: string }>(
    `/api/admin/accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  )
}

export async function reauthAccount(
  accountId: string,
): Promise<AuthStartResponse> {
  return fetchAdminJson<AuthStartResponse>(
    `/api/admin/accounts/${encodeURIComponent(accountId)}/reauth`,
    { method: "POST" },
  )
}
```

- [ ] **Step 2: Verify admin-ui builds**

Run: `cd admin-ui && bun run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/lib/admin-api.ts
git commit -m "feat: add frontend API functions for account management"
```

---

## Task 5: Add i18n strings

Add internationalization strings for the new UI elements.

**Files:**
- Modify: `admin-ui/src/locales/en-US.json`
- Modify: `admin-ui/src/locales/zh-CN.json`

- [ ] **Step 1: Add English strings**

Add to `admin-ui/src/locales/en-US.json` under a new `"accountManagement"` key:

```json
{
  "accountManagement": {
    "addAccount": "Add Account",
    "addAccountDescription": "Add a new GitHub Copilot account",
    "selectAccountType": "Select your GitHub Copilot subscription type",
    "typeIndividual": "Individual",
    "typeIndividualDescription": "Personal GitHub Copilot subscription",
    "typeBusiness": "Business",
    "typeBusinessDescription": "Organization-managed Copilot Business plan",
    "typeEnterprise": "Enterprise",
    "typeEnterpriseDescription": "GitHub Enterprise Server with custom domain",
    "enterpriseDomain": "Enterprise Domain",
    "enterpriseDomainPlaceholder": "github.example.com",
    "enterpriseDomainHint": "Your GitHub Enterprise Server hostname",
    "continue": "Continue",
    "cancel": "Cancel",
    "authorizeTitle": "Authorize with GitHub",
    "enterCodePrompt": "Enter the code below at GitHub to authorize:",
    "copy": "Copy",
    "copied": "Copied!",
    "autoOpenHint": "A new tab has been opened. If it didn't open automatically:",
    "waitingForAuth": "Waiting for authorization...",
    "expiresIn": "expires in {{time}}",
    "successTitle": "Account Added!",
    "successReauthTitle": "Account Re-authenticated!",
    "accountLabel": "Account",
    "typeLabel": "Type",
    "statusLabel": "Status",
    "statusActive": "Active",
    "done": "Done",
    "expired": "Authorization expired",
    "startOver": "Start Over",
    "retry": "Retry",
    "reauth": "Reauth",
    "delete": "Delete",
    "deleteTitle": "Delete Account",
    "deleteConfirmation": "Are you sure you want to delete account \"{{id}}\"? This action cannot be undone.",
    "deleteSuccess": "Account \"{{id}}\" deleted successfully.",
    "authFailed": "Authentication failed",
    "enterpriseDomainRequired": "Enterprise domain is required"
  }
}
```

- [ ] **Step 2: Add Chinese strings**

Add to `admin-ui/src/locales/zh-CN.json` under a new `"accountManagement"` key:

```json
{
  "accountManagement": {
    "addAccount": "添加账号",
    "addAccountDescription": "添加新的 GitHub Copilot 账号",
    "selectAccountType": "选择你的 GitHub Copilot 订阅类型",
    "typeIndividual": "Individual（个人版）",
    "typeIndividualDescription": "个人 GitHub Copilot 订阅",
    "typeBusiness": "Business（商业版）",
    "typeBusinessDescription": "组织管理的 Copilot Business 计划",
    "typeEnterprise": "Enterprise（企业版）",
    "typeEnterpriseDescription": "使用自定义域名的 GitHub Enterprise Server",
    "enterpriseDomain": "Enterprise 域名",
    "enterpriseDomainPlaceholder": "github.example.com",
    "enterpriseDomainHint": "你的 GitHub Enterprise Server 主机名",
    "continue": "继续",
    "cancel": "取消",
    "authorizeTitle": "GitHub 授权",
    "enterCodePrompt": "请在 GitHub 输入以下代码以完成授权：",
    "copy": "复制",
    "copied": "已复制！",
    "autoOpenHint": "已打开新标签页。如果未自动打开：",
    "waitingForAuth": "等待授权中...",
    "expiresIn": "{{time}} 后过期",
    "successTitle": "账号添加成功！",
    "successReauthTitle": "账号重新认证成功！",
    "accountLabel": "账号",
    "typeLabel": "类型",
    "statusLabel": "状态",
    "statusActive": "正常",
    "done": "完成",
    "expired": "授权已过期",
    "startOver": "重新开始",
    "retry": "重试",
    "reauth": "重新认证",
    "delete": "删除",
    "deleteTitle": "删除账号",
    "deleteConfirmation": "确定要删除账号 \"{{id}}\" 吗？此操作不可撤销。",
    "deleteSuccess": "账号 \"{{id}}\" 已成功删除。",
    "authFailed": "认证失败",
    "enterpriseDomainRequired": "Enterprise 域名不能为空"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/locales/en-US.json admin-ui/src/locales/zh-CN.json
git commit -m "feat: add i18n strings for account management UI"
```

---

## Task 6: Create AddAccountDialog component

Build the multi-step modal dialog for adding accounts.

**Files:**
- Create: `admin-ui/src/components/add-account-dialog.tsx`

- [ ] **Step 1: Create the AddAccountDialog component**

```tsx
// admin-ui/src/components/add-account-dialog.tsx
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type AccountType,
  type AuthStartResponse,
  type AuthStatusResponse,
  cancelAuth,
  getAuthStatus,
  reauthAccount,
  startAccountAuth,
} from "@/lib/admin-api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Step = "select-type" | "authorize" | "success" | "error"

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  /** Pre-fill for reauth flow */
  reauthAccountId?: string
}

const ACCOUNT_TYPES: AccountType[] = ["individual", "business", "enterprise"]

export function AddAccountDialog({
  open,
  onOpenChange,
  onSuccess,
  reauthAccountId,
}: AddAccountDialogProps): React.JSX.Element {
  const { t } = useTranslation()

  const [step, setStep] = useState<Step>(reauthAccountId ? "authorize" : "select-type")
  const [accountType, setAccountType] = useState<AccountType>("individual")
  const [enterpriseDomain, setEnterpriseDomain] = useState("")
  const [authSession, setAuthSession] = useState<AuthStartResponse | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      // Cleanup polling
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      // Reset state after close animation
      const timer = setTimeout(() => {
        setStep(reauthAccountId ? "authorize" : "select-type")
        setAccountType("individual")
        setEnterpriseDomain("")
        setAuthSession(null)
        setAuthStatus(null)
        setError(null)
        setCopied(false)
      }, 200)
      return () => clearTimeout(timer)
    }

    // Auto-start reauth flow
    if (reauthAccountId && open) {
      void startReauth()
    }
  }, [open, reauthAccountId])

  const startReauth = useCallback(async () => {
    if (!reauthAccountId) return
    try {
      setError(null)
      const result = await reauthAccount(reauthAccountId)
      setAuthSession(result)
      setStep("authorize")
      window.open(result.verificationUri, "_blank")
      startPolling(result.sessionId, result.interval)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep("error")
    }
  }, [reauthAccountId])

  const handleContinue = useCallback(async () => {
    if (accountType === "enterprise" && !enterpriseDomain.trim()) {
      setError(t("accountManagement.enterpriseDomainRequired"))
      return
    }

    try {
      setError(null)
      const result = await startAccountAuth({
        accountType,
        enterpriseDomain: accountType === "enterprise" ? enterpriseDomain.trim() : undefined,
      })
      setAuthSession(result)
      setStep("authorize")
      window.open(result.verificationUri, "_blank")
      startPolling(result.sessionId, result.interval)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep("error")
    }
  }, [accountType, enterpriseDomain, t])

  const startPolling = useCallback((sessionId: string, interval: number) => {
    if (pollingRef.current) clearInterval(pollingRef.current)

    pollingRef.current = setInterval(async () => {
      try {
        const status = await getAuthStatus(sessionId)
        setAuthStatus(status)

        if (status.status === "completed") {
          if (pollingRef.current) clearInterval(pollingRef.current)
          pollingRef.current = null
          setStep("success")
        } else if (status.status === "failed") {
          if (pollingRef.current) clearInterval(pollingRef.current)
          pollingRef.current = null
          setError(status.error ?? t("accountManagement.authFailed"))
          setStep("error")
        } else if (status.status === "expired") {
          if (pollingRef.current) clearInterval(pollingRef.current)
          pollingRef.current = null
          setError(t("accountManagement.expired"))
          setStep("error")
        }
      } catch {
        // Ignore polling errors — will retry on next tick
      }
    }, (interval + 1) * 1000)
  }, [t])

  const handleCancel = useCallback(async () => {
    if (authSession) {
      await cancelAuth(authSession.sessionId).catch(() => {})
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    onOpenChange(false)
  }, [authSession, onOpenChange])

  const handleDone = useCallback(() => {
    onOpenChange(false)
    onSuccess()
  }, [onOpenChange, onSuccess])

  const handleCopyCode = useCallback(async () => {
    if (!authSession) return
    await navigator.clipboard.writeText(authSession.userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [authSession])

  const handleStartOver = useCallback(() => {
    setError(null)
    setAuthSession(null)
    setAuthStatus(null)
    setStep(reauthAccountId ? "authorize" : "select-type")
    if (reauthAccountId) {
      void startReauth()
    }
  }, [reauthAccountId, startReauth])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === "select-type" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("accountManagement.addAccount")}</DialogTitle>
              <DialogDescription>{t("accountManagement.selectAccountType")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              {ACCOUNT_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setAccountType(type)}
                  className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                    accountType === type
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <div
                    className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                      accountType === type ? "border-primary" : "border-muted-foreground"
                    }`}
                  >
                    {accountType === type && (
                      <div className="bg-primary h-2.5 w-2.5 rounded-full" />
                    )}
                  </div>
                  <div>
                    <div className="font-medium">{t(`accountManagement.type${type.charAt(0).toUpperCase() + type.slice(1)}`)}</div>
                    <div className="text-muted-foreground text-sm">
                      {t(`accountManagement.type${type.charAt(0).toUpperCase() + type.slice(1)}Description`)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            {accountType === "enterprise" && (
              <div className="space-y-2">
                <Label htmlFor="enterprise-domain">
                  {t("accountManagement.enterpriseDomain")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="enterprise-domain"
                  placeholder={t("accountManagement.enterpriseDomainPlaceholder")}
                  value={enterpriseDomain}
                  onChange={(e) => setEnterpriseDomain(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t("accountManagement.enterpriseDomainHint")}</p>
              </div>
            )}
            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("accountManagement.cancel")}
              </Button>
              <Button onClick={handleContinue}>
                {t("accountManagement.continue")} →
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "authorize" && authSession && (
          <>
            <DialogHeader>
              <DialogTitle>{t("accountManagement.authorizeTitle")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-muted-foreground text-sm">{t("accountManagement.enterCodePrompt")}</p>
              <div className="relative w-full rounded-lg border-2 border-dashed border-primary/50 bg-muted p-4 text-center">
                <code className="text-2xl font-bold tracking-[0.3em]">{authSession.userCode}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-2 top-2 h-7 px-2 text-xs"
                  onClick={handleCopyCode}
                >
                  {copied ? t("accountManagement.copied") : t("accountManagement.copy")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{t("accountManagement.autoOpenHint")}</p>
              <a
                href={authSession.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary text-sm underline"
              >
                {authSession.verificationUri} →
              </a>
              <div className="flex items-center gap-2">
                <div className="bg-warning h-2 w-2 animate-pulse rounded-full" />
                <span className="text-warning text-sm">{t("accountManagement.waitingForAuth")}</span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleCancel}>
                {t("accountManagement.cancel")}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "success" && (
          <>
            <DialogHeader>
              <DialogTitle>
                {reauthAccountId
                  ? t("accountManagement.successReauthTitle")
                  : t("accountManagement.successTitle")}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-500">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <div className="bg-muted w-full rounded-lg p-4 text-sm">
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("accountManagement.accountLabel")}</span>
                  <span className="font-medium">{authStatus?.accountId ?? "—"}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("accountManagement.typeLabel")}</span>
                  <span>{accountType}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-muted-foreground">{t("accountManagement.statusLabel")}</span>
                  <span className="text-green-500">● {t("accountManagement.statusActive")}</span>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleDone}>{t("accountManagement.done")}</Button>
            </DialogFooter>
          </>
        )}

        {step === "error" && (
          <>
            <DialogHeader>
              <DialogTitle>{t("accountManagement.authFailed")}</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <p className="text-destructive text-sm">{error}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("accountManagement.cancel")}
              </Button>
              <Button onClick={handleStartOver}>
                {t("accountManagement.startOver")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Verify the component compiles**

Run: `cd admin-ui && bun run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/add-account-dialog.tsx
git commit -m "feat: add AddAccountDialog component for web UI account auth"
```

---

## Task 7: Create DeleteAccountDialog component

Build the confirmation dialog for deleting accounts.

**Files:**
- Create: `admin-ui/src/components/delete-account-dialog.tsx`

- [ ] **Step 1: Create the DeleteAccountDialog component**

```tsx
// admin-ui/src/components/delete-account-dialog.tsx
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { deleteAccount } from "@/lib/admin-api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface DeleteAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountId: string
  onDeleted: () => void
}

export function DeleteAccountDialog({
  open,
  onOpenChange,
  accountId,
  onDeleted,
}: DeleteAccountDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteAccount(accountId)
      toast.success(t("accountManagement.deleteSuccess", { id: accountId }))
      onOpenChange(false)
      onDeleted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }, [accountId, onDeleted, onOpenChange, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("accountManagement.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("accountManagement.deleteConfirmation", { id: accountId })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            {t("accountManagement.cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? "..." : t("accountManagement.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Verify the component compiles**

Run: `cd admin-ui && bun run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/delete-account-dialog.tsx
git commit -m "feat: add DeleteAccountDialog component"
```

---

## Task 8: Integrate into AccountsPage

Wire the new dialogs and action buttons into the existing accounts page.

**Files:**
- Modify: `admin-ui/src/pages/accounts-page.tsx`

- [ ] **Step 1: Add imports and state for new dialogs**

At the top of `accounts-page.tsx`, add:

```tsx
import { AddAccountDialog } from "@/components/add-account-dialog"
import { DeleteAccountDialog } from "@/components/delete-account-dialog"
import { Button } from "@/components/ui/button"
```

Inside the `AccountsPage` component, add state variables:

```tsx
const [addDialogOpen, setAddDialogOpen] = useState(false)
const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
const [deleteTargetId, setDeleteTargetId] = useState("")
const [reauthDialogOpen, setReauthDialogOpen] = useState(false)
const [reauthTargetId, setReauthTargetId] = useState("")
```

- [ ] **Step 2: Add "Add Account" button to the top control bar**

In the `<div className="flex flex-wrap items-center gap-3">` section, add the button after the RainbowButton:

```tsx
<Button variant="outline" size="sm" onClick={() => setAddDialogOpen(true)}>
  + {t("accountManagement.addAccount")}
</Button>
```

- [ ] **Step 3: Add an Actions column to the table**

Update the `accountsTableColVisibility` array to add a 9th entry:

```ts
const accountsTableColVisibility = [
  null,
  null,
  "hidden lg:table-cell",
  null,
  null,
  "hidden xl:table-cell",
  "hidden xl:table-cell",
  "hidden lg:table-cell",
  null, // Actions column
] as const
```

Add a new `<TableHead>` in the header:

```tsx
<TableHead className="text-right">{t("common.actions")}</TableHead>
```

Add a new `<TableCell>` in each row (after the last request cell):

```tsx
<TableCell className="text-right">
  <div className="flex items-center justify-end gap-1">
    <Button
      variant={failed ? "default" : "ghost"}
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={() => {
        setReauthTargetId(a.account_id)
        setReauthDialogOpen(true)
      }}
    >
      {t("accountManagement.reauth")}
    </Button>
    <Button
      variant="ghost"
      size="sm"
      className="text-destructive h-7 px-2 text-xs"
      onClick={() => {
        setDeleteTargetId(a.account_id)
        setDeleteDialogOpen(true)
      }}
    >
      {t("accountManagement.delete")}
    </Button>
  </div>
</TableCell>
```

- [ ] **Step 4: Add dialogs at the end of the component's return**

Before the closing `</div>` of the return statement:

```tsx
<AddAccountDialog
  open={addDialogOpen}
  onOpenChange={setAddDialogOpen}
  onSuccess={refresh}
/>

<AddAccountDialog
  open={reauthDialogOpen}
  onOpenChange={setReauthDialogOpen}
  onSuccess={refresh}
  reauthAccountId={reauthTargetId}
/>

<DeleteAccountDialog
  open={deleteDialogOpen}
  onOpenChange={setDeleteDialogOpen}
  accountId={deleteTargetId}
  onDeleted={refresh}
/>
```

- [ ] **Step 5: Add "actions" i18n key**

If not already present, add `"actions": "Actions"` to `en-US.json` under `"common"` and `"actions": "操作"` to `zh-CN.json`.

- [ ] **Step 6: Verify admin-ui builds**

Run: `cd admin-ui && bun run build`
Expected: Build succeeds.

- [ ] **Step 7: Verify full project builds**

Run: `bun run build`
Expected: Full project builds without errors (backend + admin-ui).

- [ ] **Step 8: Commit**

```bash
git add admin-ui/src/pages/accounts-page.tsx admin-ui/src/locales/en-US.json admin-ui/src/locales/zh-CN.json
git commit -m "feat: integrate account management dialogs into accounts page"
```

---

## Task 9: Manual integration testing

Verify the complete feature works end-to-end.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`

- [ ] **Step 2: Open Admin UI and test Add Account flow**

1. Navigate to `http://localhost:4141/admin` (or whichever port)
2. Go to the Accounts page
3. Click "Add Account"
4. Select "Individual" account type
5. Click Continue
6. Verify: new tab opens with GitHub device code page
7. Verify: dialog shows user code and waiting status
8. Complete GitHub authorization in the browser
9. Verify: dialog transitions to success step
10. Click Done
11. Verify: account appears in the accounts table

- [ ] **Step 3: Test Reauth flow**

1. Click "Reauth" on an existing account
2. Verify: dialog opens directly to authorize step
3. Complete authorization
4. Verify: success dialog shows correct account

- [ ] **Step 4: Test Delete flow**

1. Click "Delete" on an account
2. Verify: confirmation dialog appears
3. Click Delete
4. Verify: account removed from table + toast notification

- [ ] **Step 5: Test error cases**

1. Start Add Account flow but close the dialog → verify cancellation
2. Start Add Account flow and let it expire → verify expired state
3. Try Enterprise type without domain → verify validation error

- [ ] **Step 6: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix: address issues found during integration testing"
```
