import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { isForceAgentEnabled } from "~/lib/config"

const getPayloadItems = (
  payload: ResponsesPayload,
): Array<ResponseInputItem> => {
  const result: Array<ResponseInputItem> = []

  const { input } = payload

  if (typeof input === "string") {
    result.push({ role: "user", content: input })
  } else if (Array.isArray(input)) {
    result.push(...input)
  }

  return result
}

const getItemRole = (
  item: ResponseInputItem | undefined,
): string | undefined => {
  if (!item || typeof item !== "object") {
    return undefined
  }

  if (!("role" in item)) {
    return undefined
  }

  const role = (item as { role?: unknown }).role
  return typeof role === "string" ? role.toLowerCase() : undefined
}

const getLastRole = (payload: ResponsesPayload): string | undefined =>
  getItemRole(getPayloadItems(payload).at(-1))

const hasAssistantOrToolRole = (payload: ResponsesPayload): boolean =>
  getPayloadItems(payload).some((item) => {
    const role = getItemRole(item)
    return role === "assistant" || role === "tool"
  })

export const getResponsesRequestOptions = (
  payload: ResponsesPayload,
): { vision: boolean; initiator: "agent" | "user" } => {
  const vision = hasVisionInput(payload)
  const forceAgent = isForceAgentEnabled()
  const hasAssistantOrTool = hasAssistantOrToolRole(payload)
  const isLastUser = getLastRole(payload) === "user"
  let initiator: "agent" | "user"
  if (forceAgent) {
    initiator = hasAssistantOrTool ? "agent" : "user"
  } else {
    initiator = isLastUser ? "user" : "agent"
  }

  return { vision, initiator }
}

export const hasAgentInitiator = (payload: ResponsesPayload): boolean => {
  const forceAgent = isForceAgentEnabled()
  if (forceAgent) {
    return hasAssistantOrToolRole(payload)
  }
  const lastRole = getLastRole(payload)
  return lastRole !== "user"
}

export const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined

  if (type === "input_image") {
    return true
  }

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  return false
}
