import consola from "consola"
import { setTimeout as delay } from "node:timers/promises"

import { isOpencodeOauthApp } from "~/lib/api-config"
import {
  getRawProviderConfig,
  readEditableConfigFromDisk,
  setProviderConfig,
} from "~/lib/config"
import {
  readCodexCredentialStore,
  readGitHubToken,
  removeCodexCredentials,
  withCodexAccountMutationLock,
  writeCodexCredentials,
  writeGitHubToken,
  type CodexStoredAccount,
} from "~/lib/credential-store"
import {
  isCodexCredentialsExpired,
  refreshCodexCredentials,
  type CodexCredentials,
} from "~/lib/oauth/codex"
import { CODEX_API_BASE_URL } from "~/services/codex/create-responses"
import {
  getCopilotToken,
  type GetCopilotTokenResponse,
} from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getDeviceCode } from "~/services/github/get-device-code"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

let copilotRefreshLoopController: AbortController | null = null
let codexRefreshLoopController: AbortController | null = null
let codexRefreshInFlight: Promise<CodexCredentials> | null = null
let codexCredentialsPendingPersistence: CodexCredentials | null = null

export interface CodexAccountSummary {
  accountId: string
  alias?: string
  active: boolean
}

export interface PersistCodexCredentialsOptions {
  activateAccount?: boolean
  alias?: string
  enableProvider?: boolean
  insertIfMissing?: boolean
  syncProvider?: boolean
}

interface CopilotUserIdentity {
  endpoints: { api: string }
  login: string
  token_based_billing?: boolean
}

export interface CopilotTokenDependencies {
  getCopilotToken: () => Promise<GetCopilotTokenResponse>
  getCopilotUsage: () => Promise<CopilotUserIdentity | null>
}

const defaultCopilotTokenDependencies: CopilotTokenDependencies = {
  getCopilotToken,
  getCopilotUsage,
}

export const stopCopilotRefreshLoop = () => {
  if (!copilotRefreshLoopController) {
    return
  }

  copilotRefreshLoopController.abort()
  copilotRefreshLoopController = null
}

export const stopCodexRefreshLoop = () => {
  if (!codexRefreshLoopController) {
    return
  }

  codexRefreshLoopController.abort()
  codexRefreshLoopController = null
}

function applyCodexCredentials(credentials: CodexCredentials): void {
  state.codexAccessToken = credentials.accessToken
  state.codexRefreshToken = credentials.refreshToken
  state.codexExpiresAt = credentials.expiresAt
  state.codexAccountId = credentials.accountId

  consola.debug("Codex credentials loaded successfully")
  if (state.showToken) {
    consola.info("Codex access token:", credentials.accessToken)
  }
}

function getLoadedCodexCredentials(): CodexCredentials | null {
  if (
    !state.codexAccessToken
    || !state.codexRefreshToken
    || !state.codexExpiresAt
    || !state.codexAccountId
  ) {
    return null
  }

  return {
    accessToken: state.codexAccessToken,
    refreshToken: state.codexRefreshToken,
    expiresAt: state.codexExpiresAt,
    accountId: state.codexAccountId,
  }
}

function syncCodexProviderConfig(options?: {
  accountId?: string
  enabled?: boolean
}): void {
  const existingProviderConfig =
    readEditableConfigFromDisk().providers?.codex ?? {}
  setProviderConfig("codex", {
    ...existingProviderConfig,
    type: "openai-responses",
    enabled: options?.enabled ?? existingProviderConfig.enabled,
    baseUrl: CODEX_API_BASE_URL,
    authType: "oauth2",
    accountId: options?.accountId ?? existingProviderConfig.accountId,
    pricingCurrency: "USD",
  })
}

function getConfiguredCodexAccountId(): string | undefined {
  return getRawProviderConfig("codex")?.accountId?.trim() || undefined
}

function getPersistedCodexAccountId(): string | undefined {
  return (
    readEditableConfigFromDisk().providers?.codex?.accountId?.trim()
    || undefined
  )
}

function resolveActiveCodexAccountId(
  accounts: Array<CodexStoredAccount>,
  configuredAccountId: string | undefined = getConfiguredCodexAccountId(),
): string | undefined {
  return (
    configuredAccountId
    ?? (accounts.length === 1 ? accounts[0].accountId : undefined)
  )
}

function normalizeCodexSelector(selector: string): string {
  const normalizedSelector = selector.trim()
  if (!normalizedSelector) {
    throw new Error("Codex account selector must be a non-empty string")
  }

  return normalizedSelector
}

function findCodexAccount(
  accounts: Array<CodexStoredAccount>,
  selector: string,
): CodexStoredAccount | undefined {
  return (
    accounts.find((candidate) => candidate.accountId === selector)
    ?? accounts.find(
      (candidate) => candidate.alias?.toLowerCase() === selector.toLowerCase(),
    )
  )
}

function toCodexAccountSummary(
  account: CodexStoredAccount,
  active: boolean,
): CodexAccountSummary {
  return {
    accountId: account.accountId,
    ...(account.alias ? { alias: account.alias } : {}),
    active,
  }
}

export async function getCodexAccounts(): Promise<Array<CodexAccountSummary>> {
  return await withCodexAccountMutationLock(async () => {
    const accounts = (await readCodexCredentialStore())?.accounts ?? []
    const activeAccountId = resolveActiveCodexAccountId(
      accounts,
      getPersistedCodexAccountId(),
    )

    return accounts.map((account) =>
      toCodexAccountSummary(account, account.accountId === activeAccountId),
    )
  })
}

export async function selectCodexAccount(
  selector: string,
): Promise<CodexAccountSummary> {
  return await withCodexAccountMutationLock(async () => {
    const normalizedSelector = normalizeCodexSelector(selector)
    const accounts = (await readCodexCredentialStore())?.accounts ?? []
    const account = findCodexAccount(accounts, normalizedSelector)
    if (!account) {
      throw new Error(`Codex account '${normalizedSelector}' was not found`)
    }

    syncCodexProviderConfig({ accountId: account.accountId })
    return toCodexAccountSummary(account, true)
  })
}

export async function removeCodexAccount(
  selector: string,
): Promise<CodexAccountSummary> {
  return await withCodexAccountMutationLock(async () => {
    const normalizedSelector = normalizeCodexSelector(selector)
    const accounts = (await readCodexCredentialStore())?.accounts ?? []
    const account = findCodexAccount(accounts, normalizedSelector)
    if (!account) {
      throw new Error(`Codex account '${normalizedSelector}' was not found`)
    }

    if (
      account.accountId
      === resolveActiveCodexAccountId(accounts, getPersistedCodexAccountId())
    ) {
      throw new Error(
        `Codex account '${account.accountId}' is currently in use; switch to another account before removing it`,
      )
    }

    const removedAccount = await removeCodexCredentials(account.accountId)
    return toCodexAccountSummary(removedAccount, false)
  })
}

export async function persistCodexCredentials(
  credentials: CodexCredentials,
  options: PersistCodexCredentialsOptions = {},
): Promise<void> {
  const persist = async (): Promise<void> => {
    await writeCodexCredentials(credentials, {
      alias: options.alias,
      insertIfMissing: options.insertIfMissing,
    })
    if (options.syncProvider !== false) {
      syncCodexProviderConfig({
        accountId: options.activateAccount ? credentials.accountId : undefined,
        enabled: options.enableProvider ? true : undefined,
      })
    }
    applyCodexCredentials(credentials)
    codexCredentialsPendingPersistence = null
  }

  if (options.syncProvider === false) {
    await persist()
    return
  }

  await withCodexAccountMutationLock(persist)
}

export interface CodexRefreshDependencies {
  getCurrentCredentials: () => CodexCredentials | null
  persistCodexCredentials: (credentials: CodexCredentials) => Promise<void>
  refreshCodexCredentials: (
    credentials: CodexCredentials,
  ) => Promise<CodexCredentials>
}

const defaultCodexRefreshDependencies: CodexRefreshDependencies = {
  getCurrentCredentials: getLoadedCodexCredentials,
  // Refreshes may never re-create an account row. A server that was not
  // restarted after switching accounts keeps refreshing its previous account,
  // and inserting it again would undo a removal that already happened.
  persistCodexCredentials: (credentials) =>
    persistCodexCredentials(credentials, {
      insertIfMissing: false,
      syncProvider: false,
    }),
  refreshCodexCredentials,
}

/**
 * Refreshes and persists Codex credentials through one module level
 * single-flight guard.
 *
 * The upstream rotates the refresh token on every use, so two concurrent
 * refreshes with the same token make one caller fail and let the slower
 * response overwrite the persisted result. Provider resolution runs on every
 * Codex request, so a burst of requests (or the background loop waking at the
 * same moment) must share a single attempt instead of burning the token.
 */
export function refreshCodexCredentialsOnce(
  credentials: CodexCredentials,
  dependencies: CodexRefreshDependencies = defaultCodexRefreshDependencies,
): Promise<CodexCredentials> {
  const inFlight = codexRefreshInFlight
  if (inFlight) {
    return inFlight
  }

  const attempt = (async () => {
    // A successful refresh may have rotated the upstream token before local
    // persistence failed. Retry writing that exact result instead of calling
    // the refresh endpoint again with the consumed token.
    const pendingPersistence = codexCredentialsPendingPersistence
    if (pendingPersistence) {
      await dependencies.persistCodexCredentials(pendingPersistence)
      if (codexCredentialsPendingPersistence === pendingPersistence) {
        codexCredentialsPendingPersistence = null
      }
      return pendingPersistence
    }

    // The caller's snapshot may predate a refresh triggered by someone else.
    // Reusing that snapshot's token would fail and consume it, so prefer the
    // rotated credentials in state and skip the call when they are still valid.
    const current = dependencies.getCurrentCredentials()
    const rotated =
      current && current.refreshToken !== credentials.refreshToken ?
        current
      : null

    if (rotated && !isCodexCredentialsExpired(rotated)) {
      return rotated
    }

    const base = rotated ?? credentials
    const refreshed = await dependencies.refreshCodexCredentials(base)
    codexCredentialsPendingPersistence = refreshed
    await dependencies.persistCodexCredentials(refreshed)
    if (codexCredentialsPendingPersistence === refreshed) {
      codexCredentialsPendingPersistence = null
    }
    return refreshed
  })()

  codexRefreshInFlight = attempt

  const clearAttempt = () => {
    if (codexRefreshInFlight === attempt) {
      codexRefreshInFlight = null
    }
  }

  // Rejected attempts are not shared after they settle. A rotated credential
  // whose persistence failed remains cached above for a write-only retry.
  attempt.then(clearAttempt, clearAttempt)

  return attempt
}

export const applyCopilotTokenResponse = (
  response: GetCopilotTokenResponse,
): void => {
  state.copilotToken = response.token

  // The token exchange response is authoritative for routing the token it just
  // issued: `/copilot_internal/user` can disagree (e.g. enterprise seats via an
  // org entitlement advertise the business host, while the issued token is
  // bound to the enterprise host, causing 421 Misdirected Request).
  if (response.endpoints?.api) {
    state.copilotApiUrl = response.endpoints.api
  }
}

export const setupCopilotToken = async (
  dependencies: CopilotTokenDependencies = defaultCopilotTokenDependencies,
) => {
  if (isOpencodeOauthApp()) {
    if (!state.githubToken) throw new Error(`opencode token not found`)

    state.copilotToken = state.githubToken

    consola.debug("GitHub Copilot token set from opencode auth token")
    if (state.showToken) {
      consola.info("Copilot token:", state.copilotToken)
    }

    stopCopilotRefreshLoop()
    return
  }

  const response = await dependencies.getCopilotToken()
  applyCopilotTokenResponse(response)

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", state.copilotToken)
  }

  stopCopilotRefreshLoop()

  const controller = new AbortController()
  copilotRefreshLoopController = controller

  runCopilotRefreshLoop(response.refresh_in, controller.signal, dependencies)
    .catch(() => {
      consola.warn("Copilot token refresh loop stopped")
    })
    .finally(() => {
      if (copilotRefreshLoopController === controller) {
        copilotRefreshLoopController = null
      }
    })
}

export const setupCodexToken = async (): Promise<void> => {
  const configuredAccountId = getConfiguredCodexAccountId()
  const loadedCredentials = getLoadedCodexCredentials()
  if (
    configuredAccountId
    && loadedCredentials?.accountId === configuredAccountId
    && !isCodexCredentialsExpired(loadedCredentials)
    && codexRefreshLoopController
  ) {
    return
  }

  let store: Awaited<ReturnType<typeof readCodexCredentialStore>> | undefined
  let selectedAccountId = configuredAccountId
  if (!selectedAccountId) {
    store = await readCodexCredentialStore()
    if (!store || store.accounts.length === 0) {
      throw new Error(
        `Codex credentials not found. Run \`copilot-api auth login --provider codex\` first.`,
      )
    }
    if (store.accounts.length > 1) {
      throw new Error(
        "Multiple Codex accounts found but no account is selected. Run `copilot-api auth codex --use <alias-or-accountId>` first.",
      )
    }

    selectedAccountId = store.accounts[0].accountId
    syncCodexProviderConfig({ accountId: selectedAccountId })
  }

  const selectedLoadedCredentials =
    loadedCredentials?.accountId === selectedAccountId ?
      loadedCredentials
    : null
  if (
    selectedLoadedCredentials
    && !isCodexCredentialsExpired(selectedLoadedCredentials)
  ) {
    if (codexRefreshLoopController) {
      return
    }

    applyCodexCredentials(selectedLoadedCredentials)
  }

  if (loadedCredentials && !selectedLoadedCredentials) {
    stopCodexRefreshLoop()
  }

  if (!selectedLoadedCredentials) {
    store ??= await readCodexCredentialStore()
    if (!store || store.accounts.length === 0) {
      throw new Error(
        `Codex credentials not found. Run \`copilot-api auth login --provider codex\` first.`,
      )
    }
  }

  const credentials =
    selectedLoadedCredentials
    ?? store?.accounts.find(
      (account) => account.accountId === selectedAccountId,
    )
  if (!credentials) {
    throw new Error(
      `Selected Codex account '${selectedAccountId}' was not found. Run \`copilot-api auth codex --list\` to inspect available accounts.`,
    )
  }

  let nextCredentials = credentials
  if (isCodexCredentialsExpired(credentials)) {
    consola.debug("Refreshing expired Codex credentials")
    nextCredentials = await refreshCodexCredentialsOnce(credentials)
  }

  applyCodexCredentials(nextCredentials)
  stopCodexRefreshLoop()

  const controller = new AbortController()
  codexRefreshLoopController = controller

  runCodexRefreshLoop(controller.signal)
    .catch(() => {
      consola.warn("Codex token refresh loop stopped")
    })
    .finally(() => {
      if (codexRefreshLoopController === controller) {
        codexRefreshLoopController = null
      }
    })
}

const REFRESH_POLL_INTERVAL_MS = 15_000
const EARLY_REFRESH_BUFFER_MS = 60_000
const RETRY_REFRESH_DELAY_MS = 15_000
const MAX_RETRY_REFRESH_DELAY_MS = 600_000
const RETRY_REFRESH_JITTER_MS = 15_000
const MIN_REFRESH_DELAY_MS = 1_000

export const getRefreshDeadlineMs = (
  refreshIn: number,
  nowMs: number = Date.now(),
) =>
  nowMs
  + Math.max(refreshIn * 1000 - EARLY_REFRESH_BUFFER_MS, MIN_REFRESH_DELAY_MS)

// Use short wall-clock chunks so the next wake after sleep notices elapsed time
// quickly, without relying on the server's absolute expires_at matching local time.
export const getRefreshPollDelayMs = (
  refreshAtMs: number,
  nowMs: number = Date.now(),
) => Math.min(Math.max(refreshAtMs - nowMs, 0), REFRESH_POLL_INTERVAL_MS)

const runCopilotRefreshLoop = async (
  refreshIn: number,
  signal: AbortSignal,
  dependencies: Pick<CopilotTokenDependencies, "getCopilotToken">,
) => {
  let refreshAtMs = getRefreshDeadlineMs(refreshIn)
  let retryDelayMs = RETRY_REFRESH_DELAY_MS

  while (!signal.aborted) {
    const nextDelayMs = getRefreshPollDelayMs(refreshAtMs)
    if (nextDelayMs > 0) {
      await delay(nextDelayMs, undefined, { signal })
      continue
    }

    consola.debug("Refreshing Copilot token")

    try {
      const response = await dependencies.getCopilotToken()
      applyCopilotTokenResponse(response)
      refreshAtMs = getRefreshDeadlineMs(response.refresh_in)
      retryDelayMs = RETRY_REFRESH_DELAY_MS
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", state.copilotToken)
      }
    } catch (error) {
      consola.error("Failed to refresh Copilot token:", error)
      const delayMs = Math.min(
        retryDelayMs + Math.floor(Math.random() * RETRY_REFRESH_JITTER_MS),
        MAX_RETRY_REFRESH_DELAY_MS,
      )
      refreshAtMs = Date.now() + delayMs
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_REFRESH_DELAY_MS)
      consola.warn(
        `Retrying Copilot token refresh in ${Math.round(delayMs / 1000)}s`,
      )
    }
  }
}

const runCodexRefreshLoop = async (signal: AbortSignal) => {
  let refreshAtMs = Math.max(
    (state.codexExpiresAt ?? Date.now()) - EARLY_REFRESH_BUFFER_MS,
    Date.now(),
  )

  while (!signal.aborted) {
    const expiresAt = state.codexExpiresAt
    const refreshToken = state.codexRefreshToken
    if (!expiresAt || !refreshToken) {
      return
    }

    const nextDelayMs = getRefreshPollDelayMs(refreshAtMs)
    if (nextDelayMs > 0) {
      await delay(nextDelayMs, undefined, { signal })
      continue
    }

    consola.debug("Refreshing Codex credentials")

    try {
      const credentials = await refreshCodexCredentialsOnce({
        accessToken: state.codexAccessToken ?? "",
        refreshToken,
        expiresAt,
        accountId: state.codexAccountId ?? "",
      })
      refreshAtMs = Math.max(
        credentials.expiresAt - EARLY_REFRESH_BUFFER_MS,
        Date.now(),
      )
      consola.debug("Codex credentials refreshed")
    } catch (error) {
      consola.error("Failed to refresh Codex credentials:", error)
      refreshAtMs = Date.now() + RETRY_REFRESH_DELAY_MS
      consola.warn(
        `Retrying Codex token refresh in ${RETRY_REFRESH_DELAY_MS / 1000}s`,
      )
    }
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGitHubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGitHubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

export async function logUser(
  dependencies: Pick<
    CopilotTokenDependencies,
    "getCopilotUsage"
  > = defaultCopilotTokenDependencies,
) {
  const copilotUser = await dependencies.getCopilotUsage()
  if (!copilotUser) {
    throw new Error("GitHub token not found")
  }

  state.copilotApiUrl = copilotUser.endpoints.api
  state.tokenBasedBilling = copilotUser.token_based_billing
}
