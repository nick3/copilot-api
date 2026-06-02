#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import {
  addAccountToRegistry,
  listAccountsFromRegistry,
  loadAccountToken,
  loadRegistry,
  removeAccountFromRegistry,
  removeAccountToken,
  saveAccountToken,
  saveRegistry,
} from "./lib/accounts-registry"
import { loginCodex } from "./lib/oauth/codex"
import { PATHS, ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import { persistCodexCredentials, setupGitHubToken } from "./lib/token"
import {
  parseAccountType,
  type AccountMeta,
  type AccountType,
} from "./lib/types/account"
import { getCopilotUsage } from "./services/github/get-copilot-usage"
import { getDeviceCode } from "./services/github/get-device-code"
import { getGitHubUser } from "./services/github/get-user"
import { pollAccessToken } from "./services/github/poll-access-token"

/**
 * Fetch quota info for an account (used by auth ls -q)
 */
async function fetchQuotaInfo(account: AccountMeta): Promise<string> {
  try {
    const token = await loadAccountToken(account.id)
    if (!token) {
      return " | Quota: (no token)"
    }

    const usage = await getCopilotUsage({
      githubToken: token,
      accountType: account.accountType,
    })
    const premium = usage.quota_snapshots.premium_interactions

    return premium.unlimited ?
        " | Quota: unlimited"
      : ` | Quota: ${premium.remaining}/${premium.entitlement}`
  } catch (error) {
    consola.debug(`Failed to fetch quota for ${account.id}:`, error)
    return " | Quota: (failed to fetch)"
  }
}

/**
 * auth add - Add a new GitHub Copilot account
 */
const authAdd = defineCommand({
  meta: {
    name: "add",
    description: "Add a new GitHub Copilot account",
  },
  args: {
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type (individual, business, enterprise)",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token after auth",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
      consola.info("Verbose logging enabled")
    }

    state.showToken = args["show-token"]

    let accountType: AccountType
    try {
      accountType = parseAccountType(args["account-type"])
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }

    await ensurePaths()

    // Start device code flow
    consola.info("Starting GitHub device code authentication...")
    const deviceResponse = await getDeviceCode()
    consola.debug("Device code response:", deviceResponse)

    consola.info(
      `Please enter the code "${deviceResponse.user_code}" at ${deviceResponse.verification_uri}`,
    )

    // Poll for access token
    const token = await pollAccessToken(deviceResponse)

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }

    // Get user info to determine account ID
    const user = await getGitHubUser({ githubToken: token, accountType })
    const accountId = user.login

    // Save token and check if account already exists
    await saveAccountToken(accountId, token)
    const existingAccounts = await listAccountsFromRegistry()
    const alreadyExists = existingAccounts.some((acc) => acc.id === accountId)

    if (alreadyExists) {
      // Touch registry file so a running server can hot-reload updated tokens.
      await saveRegistry(await loadRegistry())

      consola.success(
        `Account "${accountId}" already exists. Token has been updated.`,
      )
    } else {
      await addAccountToRegistry({
        id: accountId,
        accountType,
        addedAt: Date.now(),
      })
      consola.success(`Account "${accountId}" added successfully!`)
    }

    consola.info(`Account type: ${accountType}`)
  },
})

/**
 * auth ls - List all registered accounts
 */
const authLs = defineCommand({
  meta: {
    name: "ls",
    description: "List all registered accounts",
  },
  args: {
    "show-quota": {
      alias: "q",
      type: "boolean",
      default: false,
      description: "Show quota information (requires API call)",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
    }

    await ensurePaths()

    const accounts = await listAccountsFromRegistry()

    if (accounts.length === 0) {
      consola.info("No accounts registered. Use 'auth add' to add an account.")
      return
    }

    consola.info(`Found ${accounts.length} account(s):\n`)

    for (const [i, account] of accounts.entries()) {
      const addedDate = new Date(account.addedAt).toLocaleString()

      const quotaInfo = args["show-quota"] ? await fetchQuotaInfo(account) : ""

      console.log(
        `  ${i + 1}. ${account.id} (${account.accountType})${quotaInfo}`,
      )
      console.log(`     Added: ${addedDate}\n`)
    }
  },
})

/**
 * auth rm - Remove an account
 */
const authRm = defineCommand({
  meta: {
    name: "rm",
    description: "Remove an account",
  },
  args: {
    target: {
      type: "positional",
      description: "Account ID or index (1-based)",
      required: true,
    },
    force: {
      alias: "f",
      type: "boolean",
      default: false,
      description: "Skip confirmation prompt",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
    }

    await ensurePaths()

    const target = args.target
    const accounts = await listAccountsFromRegistry()

    if (accounts.length === 0) {
      consola.error("No accounts to remove.")
      return
    }

    // Determine account to remove (by ID or index)
    let accountToRemove: { id: string; index: number } | undefined

    // Try parsing as index (1-based)
    const index = Number.parseInt(target, 10)
    if (!Number.isNaN(index) && index >= 1 && index <= accounts.length) {
      accountToRemove = { id: accounts[index - 1].id, index: index - 1 }
    } else {
      // Try finding by ID
      const foundIndex = accounts.findIndex((acc) => acc.id === target)
      if (foundIndex !== -1) {
        accountToRemove = { id: accounts[foundIndex].id, index: foundIndex }
      }
    }

    if (!accountToRemove) {
      consola.error(`Account "${target}" not found.`)
      consola.info("Use 'auth ls' to see available accounts.")
      return
    }

    // Confirmation
    if (!args.force) {
      const confirmed = await consola.prompt(
        `Are you sure you want to remove account "${accountToRemove.id}"?`,
        { type: "confirm" },
      )
      if (!confirmed) {
        consola.info("Cancelled.")
        return
      }
    }

    // Remove token file and registry entry
    await removeAccountToken(accountToRemove.id)
    await removeAccountFromRegistry(accountToRemove.id)

    consola.success(`Account "${accountToRemove.id}" removed.`)
  },
})

interface RunAuthOptions {
  provider?: string
  verbose: boolean
  showToken: boolean
}

const authLoginArgs = {
  provider: {
    type: "string",
    description: "Provider to log in with (copilot or codex)",
  },
  verbose: {
    alias: "v",
    type: "boolean",
    default: false,
    description: "Enable verbose logging",
  },
  "show-token": {
    type: "boolean",
    default: false,
    description: "Show provider access token on auth",
  },
} as const

const BUILTIN_PROVIDER_NAMES = ["copilot", "codex"] as const

type BuiltinProviderName = (typeof BUILTIN_PROVIDER_NAMES)[number]

const BUILTIN_PROVIDER_LABELS: Record<BuiltinProviderName, string> = {
  copilot: "GitHub Copilot",
  codex: "OpenAI Codex",
}

function isBuiltinProviderName(
  providerName: string,
): providerName is BuiltinProviderName {
  return BUILTIN_PROVIDER_NAMES.includes(providerName as BuiltinProviderName)
}

async function resolveProviderSelection(
  providerArg: string | undefined,
): Promise<BuiltinProviderName> {
  const availableProviders = [...BUILTIN_PROVIDER_NAMES]

  if (providerArg !== undefined) {
    const providerName = providerArg.trim()
    if (!isBuiltinProviderName(providerName)) {
      throw new Error(
        `Unknown provider '${providerArg}'. Expected one of: ${availableProviders.join(", ")}`,
      )
    }
    return providerName
  }

  if (availableProviders.length === 1) {
    return availableProviders[0]
  }

  const provider = await consola.prompt("Select a provider to log in with", {
    type: "select",
    options: availableProviders.map((providerName) => ({
      label: `${BUILTIN_PROVIDER_LABELS[providerName]} (${providerName})`,
      value: providerName,
    })),
  })

  if (!provider || !isBuiltinProviderName(provider)) {
    throw new Error("No provider selected")
  }

  return provider
}

async function loginWithCodex(): Promise<void> {
  const credentials = await loginCodex({
    onAuth(info) {
      consola.info("Open the following URL to authenticate with Codex:")
      consola.log(info.url)
      if (info.instructions) {
        consola.info(info.instructions)
      }
    },
    onPrompt(message) {
      return consola.prompt(message, {
        type: "text",
      })
    },
    onProgress(message) {
      consola.debug(message)
    },
  })

  await persistCodexCredentials(credentials, { enableProvider: true })
  consola.success(
    `Codex provider config written to ${PATHS.CONFIG_PATH} and credentials written to ${PATHS.CODEX_CREDENTIAL_PATH}`,
  )
}

async function loginWithProvider(provider: BuiltinProviderName): Promise<void> {
  if (provider === "copilot") {
    await setupGitHubToken({ force: true })
    consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
    return
  }

  await loginWithCodex()
}

export async function runAuthLogin(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()
  const provider = await resolveProviderSelection(options.provider)

  consola.info(`Logging in with ${BUILTIN_PROVIDER_LABELS[provider]}`)
  await loginWithProvider(provider)
}

const authLogin = defineCommand({
  meta: {
    name: "login",
    description: "Authenticate a builtin provider without running the server",
  },
  args: authLoginArgs,
  run({ args }) {
    return runAuthLogin({
      provider: args.provider,
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})

/**
 * Main auth command with subcommands
 */
export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Manage GitHub Copilot accounts",
  },
  subCommands: {
    add: authAdd,
    ls: authLs,
    rm: authRm,
    login: authLogin,
  },
  args: {
    // Legacy args for backward compatibility (when no subcommand)
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type (individual, business, enterprise)",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token after auth",
    },
  },
  async run(ctx) {
    // Check if a subcommand was specified in rawArgs.
    // Only treat the *first* raw arg as a subcommand to avoid false positives
    // when flags accept values like "add"/"ls"/"rm".
    const firstArg = ctx.rawArgs[0]
    const hasSubCommand =
      firstArg === "add"
      || firstArg === "ls"
      || firstArg === "rm"
      || firstArg === "login"

    // Backward compatibility: if no subcommand, run 'add'
    if (!hasSubCommand && authAdd.run) {
      await authAdd.run(ctx)
    }
  },
})
