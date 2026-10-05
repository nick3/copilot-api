import type { Model } from "~/services/copilot/get-models"

export const toClientModelId = (modelId: string): string => {
  const normalized = normalizeSdkModelId(modelId)
  if (!normalized) return modelId
  const versionHyphenated = normalized.version.replaceAll(".", "-")
  return `claude-${normalized.family}-${versionHyphenated}`
}

export interface NormalizedSdkModelId {
  family: string
  version: string
}

export const normalizeSdkModelId = (
  sdkModelId: string,
): NormalizedSdkModelId | undefined => {
  const lower = sdkModelId.toLowerCase()

  // Strip date suffix (8 digits at the end)
  const withoutDate = lower.replace(/-\d{8}$/, "")

  // Pattern 1: claude-{family}-{major}.{minor} (e.g., claude-haiku-4.5)
  const pattern1 = withoutDate.match(/^claude-(\w+)-(\d+)\.(\d+)$/)
  if (pattern1) {
    return { family: pattern1[1], version: `${pattern1[2]}.${pattern1[3]}` }
  }

  // Pattern 2: claude-{family}-{major}-{minor} (e.g., claude-opus-4-5, claude-haiku-3-5)
  const pattern2 = withoutDate.match(/^claude-(\w+)-(\d+)-(\d+)$/)
  if (pattern2) {
    return { family: pattern2[1], version: `${pattern2[2]}.${pattern2[3]}` }
  }

  // Pattern 3: claude-{major}-{minor}-{family} (e.g., claude-3-5-sonnet)
  const pattern3 = withoutDate.match(/^claude-(\d+)-(\d+)-(\w+)$/)
  if (pattern3) {
    return { family: pattern3[3], version: `${pattern3[1]}.${pattern3[2]}` }
  }

  // Pattern 4: claude-{family}-{major} (e.g., claude-sonnet-4)
  const pattern4 = withoutDate.match(/^claude-(\w+)-(\d+)$/)
  if (pattern4) {
    return { family: pattern4[1], version: pattern4[2] }
  }

  // Pattern 5: claude-{major}-{family} (e.g., claude-3-opus)
  const pattern5 = withoutDate.match(/^claude-(\d+)-(\w+)$/)
  if (pattern5) {
    return { family: pattern5[2], version: pattern5[1] }
  }

  return undefined
}

export function findModelById(
  models: ReadonlyArray<Model>,
  modelId: string,
): Model | undefined {
  const exact = models.find((model) => model.id === modelId)
  if (exact) return exact
  const normalized = normalizeSdkModelId(modelId)
  if (!normalized) return undefined
  return models.find((model) => {
    const candidate = normalizeSdkModelId(model.id)
    return (
      candidate?.family === normalized.family
      && candidate.version === normalized.version
    )
  })
}
