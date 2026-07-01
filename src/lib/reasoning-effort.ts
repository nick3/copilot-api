import type { Model } from "~/services/copilot/get-models"

import { getReasoningEffortForModel } from "~/lib/config"

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

const REASONING_EFFORT_RANKS = new Map<ReasoningEffort, number>(
  REASONING_EFFORTS.map((effort, index) => [effort, index]),
)

export function parseReasoningEffort(
  value: unknown,
): ReasoningEffort | undefined {
  if (typeof value !== "string") return undefined
  return REASONING_EFFORT_RANKS.has(value as ReasoningEffort) ?
      (value as ReasoningEffort)
    : undefined
}

function parseReasoningEffortSupport(
  rawSupport: ReadonlyArray<unknown> | undefined,
): Array<ReasoningEffort> | undefined {
  if (!Array.isArray(rawSupport)) return undefined

  const seen = new Set<ReasoningEffort>()
  for (const item of rawSupport) {
    const effort = parseReasoningEffort(item)
    if (effort) seen.add(effort)
  }

  const support = [...seen].sort(
    (left, right) =>
      (REASONING_EFFORT_RANKS.get(left) ?? 0)
      - (REASONING_EFFORT_RANKS.get(right) ?? 0),
  )

  return support.length > 0 ? support : undefined
}

export function getReasoningEffortSupport(
  model: Pick<Model, "capabilities"> | undefined,
): Array<ReasoningEffort> | undefined {
  return parseReasoningEffortSupport(
    model?.capabilities.supports.reasoning_effort,
  )
}

export function normalizeReasoningEffortForSupport(
  intent: unknown,
  rawSupport: ReadonlyArray<string> | undefined,
): ReasoningEffort | undefined {
  const requested = parseReasoningEffort(intent)
  if (!requested) return undefined

  const support = parseReasoningEffortSupport(rawSupport)
  if (!support) return undefined

  if (support.includes(requested)) return requested

  const requestedRank = REASONING_EFFORT_RANKS.get(requested) ?? 0
  let best = support[0]
  let bestDistance = Number.POSITIVE_INFINITY
  let bestRank = REASONING_EFFORT_RANKS.get(best) ?? 0

  for (const candidate of support) {
    const candidateRank = REASONING_EFFORT_RANKS.get(candidate) ?? 0
    const distance = Math.abs(candidateRank - requestedRank)
    if (
      distance < bestDistance
      || (distance === bestDistance && candidateRank < bestRank)
    ) {
      best = candidate
      bestDistance = distance
      bestRank = candidateRank
    }
  }

  return best
}

export function resolveReasoningEffortForTarget(params: {
  explicitEffort: unknown
  requestModel: string
  targetModel: Pick<Model, "capabilities"> | undefined
  defaultEffortResolver?: (model: string) => ReasoningEffort
}): ReasoningEffort | undefined {
  const explicit = parseReasoningEffort(params.explicitEffort)
  const defaultEffortResolver =
    params.defaultEffortResolver ?? getReasoningEffortForModel
  const intent = explicit ?? defaultEffortResolver(params.requestModel)

  return normalizeReasoningEffortForSupport(
    intent,
    params.targetModel?.capabilities.supports.reasoning_effort,
  )
}
