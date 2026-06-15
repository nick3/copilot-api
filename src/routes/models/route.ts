import { Hono } from "hono"

import { getAliasTargetSet, getModelAliases } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { getAvailableModels, toClientModelId } from "~/lib/models"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    const blockedTargets = getAliasTargetSet()
    const models = getAvailableModels()
      .filter((model) => !blockedTargets.has(model.id.toLowerCase()))
      .map((model) => {
        const is1m =
          model.capabilities.limits?.max_context_window_tokens === 1_000_000
        const clientId = toClientModelId(model.id)
        return {
          claude_model_id: is1m ? `${clientId}[1m]` : clientId,
          id: clientId,
          object: "model",
          type: "model",
          created: 0,
          created_at: new Date(0).toISOString(),
          owned_by: model.vendor,
          display_name: model.name,
        }
      })

    const aliasItems = Object.keys(getModelAliases())
    const aliasModels = aliasItems.map((alias) => ({
      claude_model_id: alias,
      id: alias,
      object: "model",
      type: "model",
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: "alias",
      display_name: alias,
    }))

    const merged = new Map<string, (typeof models)[number]>()
    for (const model of models) {
      merged.set(model.id, model)
    }
    for (const model of aliasModels) {
      if (!merged.has(model.id)) {
        merged.set(model.id, model)
      }
    }

    return c.json({
      object: "list",
      data: Array.from(merged.values()),
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
