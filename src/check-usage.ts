import { defineCommand } from "citty"
import consola from "consola"

import { ensurePaths } from "./lib/paths"
import { setupGitHubToken } from "./lib/token"
import { getCopilotUsage } from "./services/github/get-copilot-usage"

export const checkUsage = defineCommand({
  meta: {
    name: "check-usage",
    description: "Show current GitHub Copilot usage/quota information",
  },
  async run() {
    await ensurePaths()
    await setupGitHubToken()
    try {
      const usage = await getCopilotUsage()
      const premium = usage.quota_snapshots.premium_interactions
      const premiumTotal = premium.entitlement
      const premiumUsed = premiumTotal - premium.remaining
      const premiumPercentUsed =
        premiumTotal > 0 ? (premiumUsed / premiumTotal) * 100 : 0
      const premiumPercentRemaining = premium.percent_remaining
      // Highlight: bold yellow
      const premiumLine = `\u001b[1m\u001b[33mPremium: ${premiumUsed}/${premiumTotal} used (${premiumPercentUsed.toFixed(1)}% used, ${premiumPercentRemaining.toFixed(1)}% remaining)\u001b[0m`

      consola.box(
        `Copilot Usage (plan: ${usage.copilot_plan})\n`
          + `Quota resets: ${usage.quota_reset_date}\n`
          + `${premiumLine}\n`
          + `\nChat: ${JSON.stringify(usage.quota_snapshots.chat, null, 2)}\n`
          + `Completions: ${JSON.stringify(usage.quota_snapshots.completions, null, 2)}\n`
          + `Premium details: ${JSON.stringify(premium, null, 2)}`,
      )
    } catch (err) {
      consola.error("Failed to fetch Copilot usage:", err)
      process.exit(1)
    }
  },
})
