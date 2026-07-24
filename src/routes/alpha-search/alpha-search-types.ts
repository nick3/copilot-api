export interface AlphaSearchRequest {
  id: string
  model: string
  input: Array<AlphaSearchInputMessage>
  commands: AlphaSearchCommands
  settings: AlphaSearchSettings
  max_output_tokens: number
}

export interface AlphaSearchInputMessage {
  type: "message"
  role: AlphaSearchInputRole
  content: Array<AlphaSearchInputContent>
  phase?: AlphaSearchMessagePhase
  internal_chat_message_metadata_passthrough?: AlphaSearchMetadataPassthrough
}

export type AlphaSearchInputRole = "user" | "assistant" | "system" | "developer"

export type AlphaSearchInputContent =
  | AlphaSearchInputTextContent
  | AlphaSearchOutputTextContent

export interface AlphaSearchInputTextContent {
  type: "input_text"
  text: string
}

export interface AlphaSearchOutputTextContent {
  type: "output_text"
  text: string
}

export type AlphaSearchMessagePhase = "commentary" | "final_answer"

export interface AlphaSearchMetadataPassthrough {
  turn_id: string
}

export interface AlphaSearchSettings {
  allowed_callers: Array<AlphaSearchAllowedCaller>
  external_web_access: boolean
}

export type AlphaSearchAllowedCaller = "direct" | (string & {})

export interface AlphaSearchCommands {
  search_query?: Array<AlphaSearchSearchQuery>
  open?: Array<AlphaSearchOpenCommand>
  find?: Array<AlphaSearchFindCommand>
  response_length: AlphaSearchResponseLength
}

export interface AlphaSearchSearchQuery {
  q: string
}

export interface AlphaSearchOpenCommand {
  ref_id: string
  lineno?: number
}

export interface AlphaSearchFindCommand {
  ref_id: string
  pattern: string
}

export type AlphaSearchResponseLength = "short" | "medium" | "long"

export interface AlphaSearchResponse {
  encrypted_output: string
  output: string
  results: Array<AlphaSearchResult>
}

export type AlphaSearchResult = AlphaSearchTextResult

export interface AlphaSearchTextResult {
  type: "text_result"
  domain: string
  ref_id: string
  snippet: string
  title: string
  url: string
}
