export function resolveEffectiveInitiator(
  baseInitiator: "agent" | "user",
  options: {
    isCompact?: boolean
    isSubagent?: boolean
  },
): "agent" | "user" {
  if (options.isCompact || options.isSubagent) {
    return "agent"
  }

  return baseInitiator
}
