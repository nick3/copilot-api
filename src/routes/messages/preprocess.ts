import type { Model } from "~/services/copilot/get-models"

import {
  COMPACT_AUTO_CONTINUE,
  COMPACT_REQUEST,
  compactAutoContinuePromptStarts,
  compactMessageSections,
  compactSummaryPromptStart,
  compactSystemPromptStart,
  compactTextOnlyGuard,
  type CompactType,
} from "~/lib/compact"
import { getReasoningEffortForModel } from "~/lib/config"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "./anthropic-types"

export const TOOL_REFERENCE_TURN_BOUNDARY = "Tool loaded."

const IDE_EXECUTE_CODE_TOOL = "mcp__ide__executeCode"
const IDE_GET_DIAGNOSTICS_TOOL = "mcp__ide__getDiagnostics"
const IDE_GET_DIAGNOSTICS_DESCRIPTION =
  "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace."

const getAnthropicEffortForModel = (
  model: string,
): "low" | "medium" | "high" | "max" => {
  const reasoningEffort = getReasoningEffortForModel(model)

  if (reasoningEffort === "xhigh") return "max"
  if (reasoningEffort === "none" || reasoningEffort === "minimal") return "low"

  return reasoningEffort
}

const getCompactCandidateText = (message: AnthropicMessage): string => {
  if (message.role !== "user") {
    return ""
  }

  if (typeof message.content === "string") {
    return message.content
  }

  return message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) =>
      block.text.startsWith("<system-reminder>") ? "" : block.text,
    )
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const isCompactMessage = (lastMessage: AnthropicMessage): boolean => {
  const text = getCompactCandidateText(lastMessage)
  if (!text) {
    return false
  }

  return (
    text.includes(compactTextOnlyGuard)
    && text.includes(compactSummaryPromptStart)
    && compactMessageSections.some((section) => text.includes(section))
  )
}

const isCompactAutoContinueMessage = (
  lastMessage: AnthropicMessage,
): boolean => {
  const text = getCompactCandidateText(lastMessage)
  return (
    Boolean(text)
    && compactAutoContinuePromptStarts.some((promptStart) =>
      text.startsWith(promptStart),
    )
  )
}

export const getCompactType = (
  anthropicPayload: AnthropicMessagesPayload,
): CompactType => {
  const lastMessage = anthropicPayload.messages.at(-1)
  if (lastMessage && isCompactMessage(lastMessage)) {
    return COMPACT_REQUEST
  }

  if (lastMessage && isCompactAutoContinueMessage(lastMessage)) {
    return COMPACT_AUTO_CONTINUE
  }

  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart) ? COMPACT_REQUEST : 0
  }
  if (!Array.isArray(system)) return 0

  const hasCompactSystemPrompt = system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
  if (hasCompactSystemPrompt) {
    return COMPACT_REQUEST
  }

  return 0
}

export const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => getCompactType(anthropicPayload) === COMPACT_REQUEST

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  // Unable to merge, discard other text blocks, wait for the next round of re-request
  if (hasToolRef(tr)) {
    return tr
  }
  return {
    ...tr,
    content: [...tr.content, textBlock],
  }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  // Unable to merge, discard other text blocks, wait for the next round of re-request
  if (hasToolRef(tr)) {
    return tr
  }
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}

export const stripToolReferenceTurnBoundary = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const hasToolReference = msg.content.some(
      (block) => block.type === "tool_result" && hasToolRef(block),
    )
    if (!hasToolReference) continue

    msg.content = msg.content.filter(
      (block) =>
        block.type !== "text"
        || block.text.trim() !== TOOL_REFERENCE_TURN_BOUNDARY,
    )
  }
}

export const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    skipLastMessage?: boolean
  },
): void => {
  const lastMessageIndex = anthropicPayload.messages.length - 1

  for (const [index, msg] of anthropicPayload.messages.entries()) {
    if (options?.skipLastMessage && index === lastMessageIndex) continue

    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

// align with vscode copilot claude agent tools
export const sanitizeIdeTools = (payload: AnthropicMessagesPayload): void => {
  if (!payload.tools || payload.tools.length === 0) {
    return
  }

  payload.tools = payload.tools.flatMap((tool) => {
    if (tool.name === IDE_EXECUTE_CODE_TOOL) {
      return []
    }

    if (tool.name === IDE_GET_DIAGNOSTICS_TOOL) {
      return [
        {
          ...tool,
          description: IDE_GET_DIAGNOSTICS_DESCRIPTION,
        },
      ]
    }

    return [tool]
  })
}

const hasToolRef = (block: AnthropicToolResultBlock) => {
  return (
    Array.isArray(block.content)
    && block.content.some((c) => c.type === "tool_reference")
  )
}

const stripUnsupportedCacheControl = (block: Record<string, unknown>): void => {
  const cacheControl = block.cache_control
  if (
    !cacheControl
    || typeof cacheControl !== "object"
    || Array.isArray(cacheControl)
  ) {
    return
  }

  const type = (cacheControl as { type?: unknown }).type
  if (typeof type === "string") {
    block.cache_control = { type }
    return
  }

  delete block.cache_control
}

const stripTextBlockCacheControl = (block: unknown): void => {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return
  }

  const record = block as Record<string, unknown>
  if (record.type !== "text") return

  stripUnsupportedCacheControl(record)
}

export const stripCacheControl = (payload: AnthropicMessagesPayload): void => {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      stripTextBlockCacheControl(block)
    }
  }

  for (const msg of payload.messages) {
    if (!Array.isArray(msg.content)) continue

    for (const block of msg.content) {
      stripTextBlockCacheControl(block)

      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const nestedBlock of block.content) {
          stripTextBlockCacheControl(nestedBlock)
        }
      }
    }
  }
}

// Pre-request processing: filter thinking blocks for Claude models so only
// valid thinking blocks are sent to the Copilot Messages API.
const filterAssistantThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): void => {
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })
    }
  }
}

export const prepareMessagesApiPayload = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  stripCacheControl(payload)
  filterAssistantThinkingBlocks(payload)

  const hasThinking = Boolean(payload.thinking)

  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking#extended-thinking-with-tool-use
  // Using tool_choice: {"type": "any"} or tool_choice: {"type": "tool", "name": "..."} will result in an error because these options force tool use, which is incompatible with extended thinking.
  const toolChoice = payload.tool_choice
  const disableThink = toolChoice?.type === "any" || toolChoice?.type === "tool"

  if (selectedModel?.capabilities.supports.adaptive_thinking && !disableThink) {
    payload.thinking = {
      type: "adaptive",
    }
    // align with vscode copilot
    if (!hasThinking) {
      payload.thinking.display = "summarized"
    }
    payload.output_config = {
      effort: getAnthropicEffortForModel(payload.model),
    }
  }
}
