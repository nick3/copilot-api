#!/usr/bin/env node

import { defineCommand, runMain, parseArgs } from "citty"

const cliArgs = {
  "api-home": {
    type: "string",
    description: "Path to the API home directory.",
  },
  "oauth-app": {
    type: "string",
    description: "OAuth app identifier.",
  },
  "enterprise-url": {
    type: "string",
    description: "Enterprise URL for GitHub.",
  },
} as const

const args = parseArgs(process.argv, cliArgs)

// Set environment variables before loading other modules
if (typeof args["api-home"] === "string") {
  process.env.COPILOT_API_HOME = args["api-home"]
}
if (typeof args["oauth-app"] === "string") {
  process.env.COPILOT_API_OAUTH_APP = args["oauth-app"]
}
if (typeof args["enterprise-url"] === "string") {
  process.env.COPILOT_API_ENTERPRISE_URL = args["enterprise-url"]
}

const main = defineCommand({
  meta: {
    name: "copilot-api",
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: {
    auth: () => import("./auth").then((mod) => mod.auth),
    start: () => import("./start").then((mod) => mod.start),
    "check-usage": () => import("./check-usage").then((mod) => mod.checkUsage),
    debug: () => import("./debug").then((mod) => mod.debug),
    mcp: () => import("./mcp").then((mod) => mod.mcp),
  },
  args: cliArgs,
})

await runMain(main)
