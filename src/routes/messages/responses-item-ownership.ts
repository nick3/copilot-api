import { createHash } from "node:crypto"

import type {
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import type { AnthropicMessagesPayload } from "./anthropic-types"

import { decodeCompactionCarrierSignature } from "./responses-translation"

type OwnershipKeyKind = "id" | "encrypted_content"

type OwnerBearingOutputItem = Extract<
  ResponseOutputItem,
  { type: "reasoning" | "compaction" }
>

export function buildResponsesItemOwnershipKey(
  kind: OwnershipKeyKind,
  value: string,
): string {
  const digest = createHash("sha256").update(value).digest("hex")
  return `responses-item-owner:${kind}:${digest}`
}

export function extractAnthropicResponsesItemOwnerKeys(
  payload: AnthropicMessagesPayload,
): Array<string> {
  const keys: Array<string> = []

  for (const message of payload.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      if (block.type !== "thinking" || !block.signature) {
        continue
      }

      addSignatureOwnerKeys(keys, block.signature)
    }
  }

  return unique(keys)
}

export function extractResponsesResultOwnerKeys(
  result: Pick<ResponsesResult, "output">,
): Array<string> {
  const keys: Array<string> = []

  for (const item of result.output) {
    addOutputItemOwnerKeys(keys, item)
  }

  return unique(keys)
}

export function extractResponsesStreamEventOwnerKeys(
  event: ResponseStreamEvent,
): Array<string> {
  if (event.type === "response.output_item.done") {
    const keys: Array<string> = []
    addOutputItemOwnerKeys(keys, event.item)
    return unique(keys)
  }

  if (
    event.type === "response.completed"
    || event.type === "response.incomplete"
  ) {
    return extractResponsesResultOwnerKeys(event.response)
  }

  return []
}

function addSignatureOwnerKeys(keys: Array<string>, signature: string): void {
  if (signature.startsWith("cm1#")) {
    const compaction = decodeCompactionCarrierSignature(signature)
    if (compaction) {
      addRawOwnerKeys(keys, compaction.id, compaction.encrypted_content)
    }
    return
  }

  const reasoning = parseReasoningSignature(signature)
  if (!reasoning) {
    return
  }

  addRawOwnerKeys(keys, reasoning.id, reasoning.encryptedContent)
}

function parseReasoningSignature(
  signature: string,
): { encryptedContent: string; id: string } | undefined {
  const splitIndex = signature.lastIndexOf("@")
  if (splitIndex <= 0 || splitIndex === signature.length - 1) {
    return undefined
  }

  return {
    encryptedContent: signature.slice(0, splitIndex),
    id: signature.slice(splitIndex + 1),
  }
}

function addOutputItemOwnerKeys(
  keys: Array<string>,
  item: ResponseOutputItem,
): void {
  if (!isOwnerBearingOutputItem(item)) {
    return
  }

  addRawOwnerKeys(keys, item.id, item.encrypted_content)
}

function isOwnerBearingOutputItem(
  item: ResponseOutputItem,
): item is OwnerBearingOutputItem {
  return item.type === "reasoning" || item.type === "compaction"
}

function addRawOwnerKeys(
  keys: Array<string>,
  id: string | undefined,
  encryptedContent: string | undefined,
): void {
  if (id) {
    keys.push(buildResponsesItemOwnershipKey("id", id))
  }
  if (encryptedContent) {
    keys.push(
      buildResponsesItemOwnershipKey("encrypted_content", encryptedContent),
    )
  }
}

function unique(values: Array<string>): Array<string> {
  return [...new Set(values)]
}
