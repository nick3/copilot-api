import {
  ClipboardCopyIcon,
  DownloadIcon,
  LoaderCircleIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { type ReplayCollectResult } from "@/lib/admin-api"
import type { SSEEvent } from "@/lib/sse"
import { fmtLocalDateTime } from "@/lib/format"
import { JsonViewer } from "@/components/json/json-viewer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export type ReplayResponsePanelProps = {
  result: ReplayCollectResult | null
  liveEvents: Array<SSEEvent> | null
  loading: boolean
  originalPath: string | null
}

/* ---- helpers ---- */

function statusVariant(status: number): "destructive" | "secondary" {
  return status >= 400 ? "destructive" : "secondary"
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const HIGHLIGHT_HEADERS = [
  "retry-after",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]

function getRawText(result: ReplayCollectResult | null, liveEvents: Array<SSEEvent> | null): string {
  if (result) return result.raw.body
  if (liveEvents) return liveEvents.map((e) => (e.event ? `event: ${e.event}\n` : "") + `data: ${e.data}`).join("\n\n")
  return ""
}

function copyRaw(text: string, t: (k: string) => string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(t("requestDetailPage.toast.copiedJson")),
    (err) => toast.error(t("requestDetailPage.toast.copyFailed"), { description: String(err) }),
  )
}

function downloadRaw(text: string, requestId: string, t: (k: string) => string): void {
  try {
    const blob = new Blob([text], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `replay-${requestId}.txt`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(t("requestDetailPage.toast.downloadedJson"))
  } catch (err) {
    toast.error(t("requestDetailPage.toast.downloadFailed"), { description: String(err) })
  }
}

export function ReplayResponsePanel({
  result,
  liveEvents,
  loading,
  originalPath,
}: ReplayResponsePanelProps): React.JSX.Element {
  const { t } = useTranslation()

  const hasData = Boolean(result) || (liveEvents && liveEvents.length > 0)
  const rawText = getRawText(result, liveEvents)

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
        <CardTitle className="text-base">{t("replayPage.response.title")}</CardTitle>
        {hasData && (
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => copyRaw(rawText, t)}>
              <ClipboardCopyIcon className="size-4" />
              {t("common.copy")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => downloadRaw(rawText, "response", t)}>
              <DownloadIcon className="size-4" />
              {t("common.download")}
            </Button>
          </div>
        )}
      </CardHeader>

      {/* Summary bar */}
      {result && (
        <div className="border-b px-4 pb-2 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground">{t("replayPage.response.status")}</span>
          <Badge variant={statusVariant(result.status)}>{result.status} {result.statusText}</Badge>
          <span className="text-muted-foreground">{t("replayPage.response.duration")}</span>
          <span className="font-mono">{result.durationMs}ms</span>
          <span className="text-muted-foreground">{t("replayPage.response.replayedAt")}</span>
          <span className="font-mono">{fmtLocalDateTime(result.replayedAt) ?? "—"}</span>
        </div>
      )}

      <CardContent className="flex-1 overflow-auto pt-2">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && !hasData && (
          <p className="text-muted-foreground text-sm py-8 text-center">
            {t("replayPage.response.empty")}
          </p>
        )}

        {!loading && hasData && (
          <ResponseTabs result={result} liveEvents={liveEvents} originalPath={originalPath} />
        )}
      </CardContent>
    </Card>
  )
}

function ResponseTabs({
  result,
  liveEvents,
  originalPath,
}: {
  result: ReplayCollectResult | null
  liveEvents: Array<SSEEvent> | null
  originalPath: string | null
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Tabs defaultValue="raw" className="gap-2">
      <TabsList>
        <TabsTrigger value="raw">{t("replayPage.response.tabRaw")}</TabsTrigger>
        <TabsTrigger value="translated">{t("replayPage.response.tabTranslated")}</TabsTrigger>
        <TabsTrigger value="headers">{t("replayPage.response.tabHeaders")}</TabsTrigger>
      </TabsList>

      <TabsContent value="raw">
        <RawTab result={result} liveEvents={liveEvents} />
      </TabsContent>

      <TabsContent value="translated">
        <TranslatedTab result={result} liveEvents={liveEvents} originalPath={originalPath} />
      </TabsContent>

      <TabsContent value="headers">
        <HeadersTab result={result} />
      </TabsContent>
    </Tabs>
  )
}

function RawTab({
  result,
  liveEvents,
}: {
  result: ReplayCollectResult | null
  liveEvents: Array<SSEEvent> | null
}): React.JSX.Element {
  const { t } = useTranslation()

  if (liveEvents && !result) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          {t("replayPage.response.streamingChunks", { count: liveEvents.length })}
        </p>
        <pre className="bg-muted/20 overflow-auto rounded-md border p-3 font-mono text-xs max-h-[60vh] whitespace-pre-wrap break-words">
          {liveEvents.map((e) => (e.event ? `event: ${e.event}\n` : "") + `data: ${e.data}`).join("\n\n")}
        </pre>
      </div>
    )
  }

  if (!result) return <></>

  if (result.raw.kind === "json") {
    const parsed = tryParseJson(result.raw.body)
    if (parsed !== null) return <JsonViewer value={parsed} defaultExpandedDepth={3} />
    return <pre className="bg-muted/20 overflow-auto rounded-md border p-3 font-mono text-xs max-h-[60vh] whitespace-pre-wrap break-words">{result.raw.body}</pre>
  }

  return (
    <pre className="bg-muted/20 overflow-auto rounded-md border p-3 font-mono text-xs max-h-[60vh] whitespace-pre-wrap break-words">
      {result.raw.body}
    </pre>
  )
}

function TranslatedTab({
  result,
  liveEvents,
  originalPath,
}: {
  result: ReplayCollectResult | null
  liveEvents: Array<SSEEvent> | null
  originalPath: string | null
}): React.JSX.Element {
  const { t } = useTranslation()

  if (originalPath !== "/v1/messages") {
    return <p className="text-muted-foreground text-sm py-4">{t("replayPage.response.translationUnavailable")}</p>
  }

  if (liveEvents && !result) {
    return (
      <p className="text-muted-foreground text-sm py-4 flex items-center gap-1.5">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        {t("replayPage.response.streamingTranslation")}
      </p>
    )
  }

  if (!result) return <></>

  const translated = result.translated
  if (translated && typeof translated === "object" && "error" in (translated as Record<string, unknown>)) {
    return (
      <p className="text-destructive text-sm py-4">
        {t("replayPage.response.translationError")}: {String((translated as { error: unknown }).error)}
      </p>
    )
  }

  if (translated != null) return <JsonViewer value={translated} defaultExpandedDepth={3} />

  return <p className="text-muted-foreground text-sm py-4">{t("replayPage.response.translationUnavailable")}</p>
}

function HeadersTab({
  result,
}: {
  result: ReplayCollectResult | null
}): React.JSX.Element {
  const { t } = useTranslation()

  if (!result) {
    return <p className="text-muted-foreground text-sm py-4">{t("replayPage.response.empty")}</p>
  }

  const entries = Object.entries(result.headers)
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm py-4">No headers</p>
  }

  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-xs">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="border-b last:border-b-0">
              <td className={`px-3 py-1.5 font-mono font-medium whitespace-nowrap ${HIGHLIGHT_HEADERS.some((h) => key.toLowerCase().startsWith(h)) ? "text-foreground bg-accent/30" : "text-muted-foreground"}`}>
                {key}
              </td>
              <td className="px-3 py-1.5 font-mono break-all">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
