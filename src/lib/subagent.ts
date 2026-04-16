export const subagentMarkerPrefix = "__SUBAGENT_MARKER__"

export interface SubagentMarker {
  session_id: string
  agent_id: string
  agent_type: string
}
