import type { Model } from "~/services/copilot/get-models"

import { isCopilotUseLocalModelsEnabled } from "./config"

export interface ModelAvailabilityOptions {
  allowDisabledPolicy?: boolean
}

/**
 * Returns whether a Copilot model may be exposed to clients and selected for
 * requests. Local model mode intentionally keeps its bundled compatibility
 * catalog available even when entries retain an upstream disabled policy.
 */
export function isCopilotModelAvailable(
  model: Model,
  options: ModelAvailabilityOptions = {},
): boolean {
  const allowDisabledPolicy =
    options.allowDisabledPolicy ?? isCopilotUseLocalModelsEnabled()

  return (
    (allowDisabledPolicy || model.policy?.state !== "disabled")
    && (model.model_picker_enabled || model.capabilities.type === "embeddings")
  )
}
