import type { AdminRequestItem } from "./admin-api"

const EMPTY = "—"
const PREVIEW_HEAD_COUNT = 2
const PREVIEW_TAIL_COUNT = 1
const PREVIEW_LINE_LIMIT = 96

type ResponsesItemOwnerFields = Pick<
  AdminRequestItem,
  | "responses_item_owner_lookup_keys_json"
  | "responses_item_owner_recorded_keys_json"
>

export type RequestDetailResponsesItemOwnerValue = {
  raw: string
  lines: Array<string>
  count: number
  charCount: number
  previewLines: Array<string>
  hiddenCount: number
  empty: boolean
}

export type RequestDetailResponsesItemOwnerRow = {
  id: "lookup" | "recorded"
  labelKey: string
  tooltipKey: string
  value: RequestDetailResponsesItemOwnerValue
}

export function buildRequestDetailResponsesItemOwnerRows(
  item: Partial<ResponsesItemOwnerFields>,
): Array<RequestDetailResponsesItemOwnerRow> {
  return [
    {
      id: "lookup",
      labelKey: "requestDetailPage.fields.responsesItemOwnerLookupKeys",
      tooltipKey: "requestDetailPage.fieldTooltip.responsesItemOwnerLookupKeys",
      value: formatOwnerKeys(item.responses_item_owner_lookup_keys_json),
    },
    {
      id: "recorded",
      labelKey: "requestDetailPage.fields.responsesItemOwnerRecordedKeys",
      tooltipKey: "requestDetailPage.fieldTooltip.responsesItemOwnerRecordedKeys",
      value: formatOwnerKeys(item.responses_item_owner_recorded_keys_json),
    },
  ]
}

function formatOwnerKeys(
  raw: string | null | undefined,
): RequestDetailResponsesItemOwnerValue {
  if (!raw) {
    return emptyValue()
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return formatOwnerKeyLines(splitLines(raw), raw)
    }

    const values = parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)

    if (values.length === 0) {
      return emptyValue()
    }

    return formatOwnerKeyLines(values, values.join("\n"))
  } catch {
    return formatOwnerKeyLines(splitLines(raw), raw)
  }
}

function formatOwnerKeyLines(
  lines: Array<string>,
  raw: string,
): RequestDetailResponsesItemOwnerValue {
  if (lines.length === 0) {
    return emptyValue()
  }

  const previewLines = buildPreviewLines(lines)

  return {
    raw,
    lines,
    count: lines.length,
    charCount: raw.length,
    previewLines,
    hiddenCount: Math.max(0, lines.length - previewLines.length),
    empty: false,
  }
}

function buildPreviewLines(lines: Array<string>): Array<string> {
  const preview =
    lines.length <= PREVIEW_HEAD_COUNT + PREVIEW_TAIL_COUNT ?
      lines
    : [
        ...lines.slice(0, PREVIEW_HEAD_COUNT),
        ...lines.slice(-PREVIEW_TAIL_COUNT),
      ]

  return preview.map((line) => truncatePreviewLine(line))
}

function truncatePreviewLine(line: string): string {
  return line.length <= PREVIEW_LINE_LIMIT ?
      line
    : `${line.slice(0, PREVIEW_LINE_LIMIT - 1)}…`
}

function splitLines(raw: string): Array<string> {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function emptyValue(): RequestDetailResponsesItemOwnerValue {
  return {
    raw: EMPTY,
    lines: [],
    count: 0,
    charCount: 0,
    previewLines: [EMPTY],
    hiddenCount: 0,
    empty: true,
  }
}
