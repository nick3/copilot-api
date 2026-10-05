import { resolveModelAlias } from "./config"
import { findModelById, normalizeSdkModelId } from "./model-id"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"

import {
  isCopilotModelAvailable,
  type ModelAvailabilityOptions,
} from "./model-availability"

export const getAvailableModels = (): Array<Model> =>
  (accountsManager.getFirstAccountModels()?.data ?? []).filter((model) =>
    isCopilotModelAvailable(model),
  )

/**
 * Converts a Copilot upstream model ID to a client-friendly ID that Claude Code
 * and Claude Desktop recognize (dots in version replaced with hyphens).
 * e.g. "claude-sonnet-4.6" -> "claude-sonnet-4-6"
 * Non-Claude models are returned unchanged.
 */
export { toClientModelId, normalizeSdkModelId } from "./model-id"
export type { NormalizedSdkModelId } from "./model-id"

export const findEndpointModel = (sdkModelId: string): Model | undefined => {
  const modelId = resolveModelAlias(sdkModelId)
  return (
    findModelById(getAvailableModels(), modelId)
    ?? findModelById(accountsManager.getModelsForRouting(), modelId)
  )
}

/**
 * Finds the latest available model for a given Claude family (e.g. "opus",
 * "sonnet", "haiku") in an account-managed model list. "Latest" is
 * determined by the highest semantic version parsed from the model ID.
 */
export const getLatestModelForFamily = (
  models: ReadonlyArray<Model>,
  family: string,
  availabilityOptions?: ModelAvailabilityOptions,
): Model | undefined => {
  let best: { model: Model; major: number; minor: number } | undefined

  for (const model of models) {
    if (!isCopilotModelAvailable(model, availabilityOptions)) {
      continue
    }

    const normalized = normalizeSdkModelId(model.id)
    if (!normalized || normalized.family !== family) {
      continue
    }

    const [majorPart, minorPart = "0"] = normalized.version.split(".")
    const major = Number.parseInt(majorPart, 10)
    const minor = Number.parseInt(minorPart, 10)
    if (Number.isNaN(major) || Number.isNaN(minor)) {
      continue
    }

    if (
      !best
      || major > best.major
      || (major === best.major && minor > best.minor)
    ) {
      best = { model, major, minor }
    }
  }

  return best?.model
}
