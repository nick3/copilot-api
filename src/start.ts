#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"

import {
  registerQuotaRefreshSchedulerShutdownCleanup,
  startQuotaRefreshSchedulerFromConfig,
} from "~/lib/quota-refresh-scheduler-runtime"
import { isMcpHttpEnabledFromEnv } from "~/mcp-http-config"
import {
  createResponsesWebSocketHandler,
  handleResponsesWebSocketUpgrade,
} from "~/routes/responses/websocket"

import {
  DEFAULT_SERVER_HOST,
  resolveServerBinding,
  formatServerUrl,
} from "./lib/server-host"
import { getConfiguredApiKeys } from "./lib/request-auth"

import { accountsManager } from "./lib/accounts-manager"
import { addAccountToRegistry, saveAccountToken } from "./lib/accounts-registry"
import {
  getModelRefreshIntervalMs,
  isAccountAffinityEnabled,
  mergeConfigWithDefaults,
} from "./lib/config"
import { getLatestModelForFamily } from "./lib/models"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { applySharedSessionAffinityRetention } from "./lib/session-affinity-store"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { parseAccountType, type AccountType } from "./lib/types/account"
import {
  cacheMacMachineId,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "./lib/utils"
import { getDeviceCode } from "./services/github/get-device-code"
import { getGitHubUser } from "./services/github/get-user"
import { pollAccessToken } from "./services/github/poll-access-token"

interface RunServerOptions {
  port: number
  host?: string
  verbose: boolean
  accountType: AccountType
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  skipAuth: boolean
  enableMcpHttp: boolean
}

/**
 * Run the interactive authentication flow to add a new account.
 * Offered in interactive terminals after the HTTP server is listening.
 */
async function runAuthFlow(accountType: AccountType): Promise<void> {
  consola.warn("No accounts found. Starting authentication flow...")

  // Start device code flow
  const deviceResponse = await getDeviceCode()
  consola.info(
    `Please enter the code "${deviceResponse.user_code}" at ${deviceResponse.verification_uri}`,
  )

  // Poll for access token
  const token = await pollAccessToken(deviceResponse)

  if (state.showToken) {
    consola.info("GitHub token:", token)
  }

  // Get user info to determine account ID
  const user = await getGitHubUser({
    githubToken: token,
    accountType,
  })
  const accountId = user.login

  // Save token and add to registry
  await saveAccountToken(accountId, token)
  await addAccountToRegistry({
    id: accountId,
    accountType,
    addedAt: Date.now(),
  })

  consola.success(`Account "${accountId}" added successfully!`)
}

function logClaudeCodeTip(): void {
  consola.log(
    "\n💡 Tip: The --claude-code flag simply generates a clipboard command for launching Claude Code. \n"
      + "All models remain fully accessible without this flag, just configure the model ID directly in your settings.json file.",
  )
}

type AvailableModels = NonNullable<
  ReturnType<typeof accountsManager.getFirstAccountModels>
>

function setupClaudeCode(models: AvailableModels, serverUrl: string): void {
  // Default to the latest available model for each Claude Code size tier so
  // opus maps to opus, sonnet maps to sonnet, and haiku maps to haiku.
  const opusModel = getLatestModelForFamily(models.data, "opus")?.id
  const sonnetModel = getLatestModelForFamily(models.data, "sonnet")?.id
  const haikuModel = getLatestModelForFamily(models.data, "haiku")?.id

  consola.info(
    "Selected default Claude Code models:\n"
      + `- Opus:   ${opusModel ?? "(none available)"}\n`
      + `- Sonnet: ${sonnetModel ?? "(none available)"}\n`
      + `- Haiku:  ${haikuModel ?? "(none available)"}`,
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS ?? "600000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: sonnetModel ?? opusModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_BEDROCK: "0",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "true",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      CLAUDE_PLUGIN_ENABLE_QUESTION_RULES: "true",
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER:
        process.env.CLAUDE_CODE_TOTAL_TOKENS_REMINDER ?? "off",
      MCP_CONNECT_TIMEOUT_MS: process.env.MCP_CONNECT_TIMEOUT_MS ?? "20000",
      CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL,
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // Fail fast before any config merge, account init, interactive auth, or quota
  // scheduler work: the server relies on Bun.serve for the Responses WebSocket
  // transport, so running under Node would otherwise crash with
  // "ReferenceError: Bun is not defined" only after all that setup.
  if (typeof Bun === "undefined") {
    consola.error(
      "The Responses WebSocket transport requires the Bun runtime. Start the proxy with 'bun' or 'bunx --bun' instead of Node.",
    )
    process.exit(1)
  }

  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  // Work around unjs/consola#357 until a release includes PR #359.
  consola.options.throttle = 0

  // Ensure config is merged with defaults at startup
  mergeConfigWithDefaults()
  accountsManager.setAccountAffinityEnabled(isAccountAffinityEnabled())
  accountsManager.setModelsRefreshIntervalMs(getModelRefreshIntervalMs())

  await initOpencodeVersion()

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  const enableMcpHttp = options.enableMcpHttp || isMcpHttpEnabledFromEnv()
  if (enableMcpHttp) {
    consola.warn(
      "Main server MCP endpoint is enabled and unauthenticated at /mcp.",
    )
  }

  state.verbose = options.verbose
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken

  const binding = resolveServerBinding(
    options.host ?? process.env.HOST ?? DEFAULT_SERVER_HOST,
    getConfiguredApiKeys().length > 0,
  )
  await ensurePaths()
  applySharedSessionAffinityRetention()
  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()

  // Initialize accounts manager with VS Code version
  await accountsManager.initialize(state.vsCodeVersion)

  // If --github-token is provided, set it as a temporary (high priority) account
  const temporaryGithubToken =
    options.githubToken ?? process.env.COPILOT_API_GITHUB_TOKEN?.trim()
  if (temporaryGithubToken) {
    await accountsManager.setTemporaryAccount(
      temporaryGithubToken,
      options.accountType,
    )
    consola.info("Using provided GitHub token as temporary account")
  }

  const hasAccounts = accountsManager.hasAccounts()
  const startInteractiveAuth =
    !hasAccounts
    && !options.skipAuth
    && Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!hasAccounts) {
    consola.warn(
      "No accounts found. Starting the server so you can add accounts via the Admin UI or `auth add`.",
    )
  }

  startQuotaRefreshSchedulerFromConfig()
  registerQuotaRefreshSchedulerShutdownCleanup()

  // Get models from the first available account
  const models = accountsManager.getFirstAccountModels()

  consola.info(
    `Available models: \n${models?.data.map((model) => `- ${model.id}`).join("\n") ?? "(no models loaded)"}`,
  )

  const serverUrl = formatServerUrl(binding.clientHostname, options.port)

  if (options.claudeCode) {
    logClaudeCodeTip()
    if (!models?.data.length) {
      consola.warn(
        "Claude Code setup requires available models. Admin UI will remain available to add an account.",
      )
    } else {
      setupClaudeCode(models, serverUrl)
    }
  }

  consola.box(`🌐 Admin UI: ${serverUrl}/admin`)

  const { createServer } = await import("./server")
  const server = createServer({
    enableMcpHttp,
    networkExposed: binding.networkExposed,
  })
  const responsesWebSocketHandler = createResponsesWebSocketHandler(
    server.fetch,
  )

  Bun.serve({
    hostname: binding.hostname,
    port: options.port,
    idleTimeout: 0,
    fetch: (request, bunServer) => {
      const websocketResponse = handleResponsesWebSocketUpgrade(
        request,
        bunServer,
        { allowWhenNoApiKeys: !binding.networkExposed },
      )
      if (websocketResponse !== null) {
        return websocketResponse
      }

      return server.fetch(request)
    },
    websocket: responsesWebSocketHandler,
  })

  // Login may wait indefinitely for a user or fail offline. It must not gate
  // Admin availability, and reloading must not reset other accounts added via UI.
  if (startInteractiveAuth) {
    void runAuthFlow(options.accountType)
      .then(async () => {
        await accountsManager.reloadRegistryNow()
        const authenticatedModels = accountsManager.getFirstAccountModels()
        if (options.claudeCode && authenticatedModels?.data.length) {
          setupClaudeCode(authenticatedModels, serverUrl)
        }
      })
      .catch((error: unknown) => {
        consola.error(
          "Failed to add account; Admin UI is still available:",
          error,
        )
      })
  }
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    host: {
      type: "string",
      description: "Host to listen on (defaults to HOST or 127.0.0.1)",
    },
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "skip-auth": {
      type: "boolean",
      default: false,
      description:
        "Skip background device login in an interactive terminal. Headless startup always uses Admin UI or auth add.",
    },
    "enable-mcp-http": {
      type: "boolean",
      default: false,
      description:
        "Expose the unauthenticated MCP Streamable HTTP endpoint at /mcp.",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    let accountType: AccountType
    try {
      accountType = parseAccountType(args["account-type"])
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }

    return runServer({
      port: Number.parseInt(args.port, 10),
      host: args.host,
      verbose: args.verbose,
      accountType,
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      skipAuth: args["skip-auth"],
      enableMcpHttp: args["enable-mcp-http"],
    })
  },
})
