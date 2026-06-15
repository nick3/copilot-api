import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  LoaderCircleIcon,
  PlayIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useLocation, useParams } from "react-router-dom"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminRequestItem,
  getAdminRequestDetail,
  getDevMode,
} from "@/lib/admin-api"
import { copyText as writeClipboardText } from "@/lib/clipboard"
import { fmtDurationSeconds, fmtLocalDateTime, fmtNum } from "@/lib/format"
import { i18n } from "@/lib/i18n"
import { formatRequestCreditsRemaining } from "@/lib/request-credits"
import {
  buildRequestDetailResponsesItemOwnerRows,
  type RequestDetailResponsesItemOwnerRow,
} from "@/lib/request-detail-ownership"
import { cn } from "@/lib/utils"
import { JsonViewer } from "@/components/json/json-viewer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { InlineAlert } from "@/components/ui/inline-alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const EMPTY = "—"

export function buildRequestDetailUpstreamHeaderRows(
  item: AdminRequestItem,
): Array<{
  labelKey: string
  tooltipKey: string
  value: string
}> {
  return [
    {
      labelKey: "requestDetailPage.fields.outboundXRequestId",
      tooltipKey: "requestDetailPage.fieldTooltip.outboundXRequestId",
      value: item.outbound_x_request_id || EMPTY,
    },
    {
      labelKey: "requestDetailPage.fields.outboundXAgentTaskId",
      tooltipKey: "requestDetailPage.fieldTooltip.outboundXAgentTaskId",
      value: item.outbound_x_agent_task_id || EMPTY,
    },
    {
      labelKey: "requestDetailPage.fields.outboundXInteractionId",
      tooltipKey: "requestDetailPage.fieldTooltip.outboundXInteractionId",
      value: item.outbound_x_interaction_id || EMPTY,
    },
    {
      labelKey: "requestDetailPage.fields.outboundXInteractionType",
      tooltipKey: "requestDetailPage.fieldTooltip.outboundXInteractionType",
      value: item.outbound_x_interaction_type || EMPTY,
    },
    {
      labelKey: "requestDetailPage.fields.outboundOpenaiIntent",
      tooltipKey: "requestDetailPage.fieldTooltip.outboundOpenaiIntent",
      value: item.outbound_openai_intent || EMPTY,
    },
    {
      labelKey: "requestDetailPage.fields.outboundUserAgent",
      tooltipKey: "requestDetailPage.fieldTooltip.outboundUserAgent",
      value: item.outbound_user_agent || EMPTY,
    },
  ]
}

function StatusBadge({ status }: { status: number }): React.JSX.Element {
  return status >= 400 ? (
    <Badge variant="destructive">{status}</Badge>
  ) : (
    <Badge variant="secondary">{status}</Badge>
  )
}

function SectionHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={2}
        className="bg-muted/30 py-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
      >
        {label}
      </TableCell>
    </TableRow>
  )
}

function FieldLabel({
  label,
  tooltip,
}: {
  label: string
  tooltip?: string
}): React.JSX.Element {
  if (!tooltip) return <>{label}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dashed decoration-current/30 underline-offset-2">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-60">
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    return typeof window !== "undefined" ? window.matchMedia(query).matches : true
  })

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined
    }

    const mediaQuery = window.matchMedia(query)
    const update = () => setMatches(mediaQuery.matches)

    update()
    mediaQuery.addEventListener("change", update)

    return () => mediaQuery.removeEventListener("change", update)
  }, [query])

  return matches
}

function OwnerKeysSummaryValue({
  row,
  onView,
  onCopy,
  onDownload,
}: {
  row: RequestDetailResponsesItemOwnerRow
  onView: () => void
  onCopy: () => void
  onDownload: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  if (row.value.empty) {
    return <>{row.value.raw}</>
  }

  return (
    <div className="space-y-2 py-0.5">
      <div className="font-sans text-[11px] text-muted-foreground">
        {t("requestDetailPage.ownerKeys.summary", {
          keyCount: fmtNum(row.value.count),
          charCount: fmtNum(row.value.charCount),
        })}
      </div>

      <div className="rounded-md border bg-muted/15 p-2">
        <div className="font-mono text-[11px] leading-5 whitespace-pre-wrap break-all">
          {row.value.previewLines.join("\n")}
        </div>
        {row.value.hiddenCount > 0 ? (
          <div className="mt-2 font-sans text-[11px] text-muted-foreground">
            {t("requestDetailPage.ownerKeys.morePreview", {
              hiddenCount: fmtNum(row.value.hiddenCount),
            })}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 font-sans">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={onView}
        >
          <EyeIcon className="size-3.5" />
          {t("requestDetailPage.ownerKeys.viewAll")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={onCopy}
        >
          <CopyIcon className="size-3.5" />
          {t("common.copy")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={onDownload}
        >
          <DownloadIcon className="size-3.5" />
          {t("common.download")}
        </Button>
      </div>
    </div>
  )
}

function OwnerKeysViewer({
  row,
  open,
  isDesktop,
  onOpenChange,
  onCopy,
  onDownload,
}: {
  row: RequestDetailResponsesItemOwnerRow | null
  open: boolean
  isDesktop: boolean
  onOpenChange: (open: boolean) => void
  onCopy: () => void
  onDownload: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [filter, setFilter] = useState("")
  const [wrapLines, setWrapLines] = useState(true)

  if (!row || row.value.empty) {
    return null
  }

  const normalizedFilter = filter.trim().toLowerCase()
  const filteredLines = normalizedFilter
    ? row.value.lines.filter((line) =>
        line.toLowerCase().includes(normalizedFilter),
      )
    : row.value.lines
  const title = t(row.labelKey)
  const description = t("requestDetailPage.ownerKeys.viewerDescription")

  const viewerBody = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 sm:px-6 sm:pb-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("requestDetailPage.ownerKeys.searchPlaceholder")}
          aria-label={t("requestDetailPage.ownerKeys.searchPlaceholder")}
          className="h-8 sm:max-w-sm"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            aria-pressed={wrapLines}
            onClick={() => setWrapLines((value) => !value)}
          >
            {wrapLines ?
              t("requestDetailPage.ownerKeys.preserveLineBreaks")
            : t("requestDetailPage.ownerKeys.wrapLines")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={onCopy}
          >
            <CopyIcon className="size-3.5" />
            {t("requestDetailPage.ownerKeys.copyAll")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={onDownload}
          >
            <DownloadIcon className="size-3.5" />
            {t("requestDetailPage.ownerKeys.downloadAll")}
          </Button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        {t("requestDetailPage.ownerKeys.viewerStats", {
          shownCount: fmtNum(filteredLines.length),
          totalCount: fmtNum(row.value.count),
          charCount: fmtNum(row.value.charCount),
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/10 p-3">
        {filteredLines.length > 0 ? (
          <div
            className={cn(
              "font-mono text-xs leading-5",
              wrapLines ?
                "whitespace-pre-wrap break-all"
              : "overflow-x-auto whitespace-pre",
            )}
          >
            {filteredLines.join("\n")}
          </div>
        ) : (
          <div className="flex h-full min-h-24 items-center justify-center text-sm text-muted-foreground">
            {t("requestDetailPage.ownerKeys.noMatches")}
          </div>
        )}
      </div>
    </div>
  )

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="border-b px-4 pt-4 pb-4 sm:px-6">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {viewerBody}
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[85vh] flex-col gap-0 rounded-t-xl p-0"
      >
        <SheetHeader className="border-b px-4 py-4 text-left">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {viewerBody}
      </SheetContent>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export function RequestDetailPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { requestId = "" } = useParams()
  const location = useLocation()

  const fromSearch = (location.state as { fromSearch?: string } | null)
    ?.fromSearch
  const backTo = fromSearch ? `/requests?${fromSearch}` : "/requests"

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [item, setItem] = useState<AdminRequestItem | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [devModeEnabled, setDevModeEnabled] = useState(false)
  const [hasOutbound, setHasOutbound] = useState(false)
  const [activeOwnerKeysRowId, setActiveOwnerKeysRowId] = useState<
    RequestDetailResponsesItemOwnerRow["id"] | null
  >(null)
  const isDesktop = useMediaQuery("(min-width: 640px)")

  useEffect(() => {
    setActiveOwnerKeysRowId(null)
  }, [requestId])

  useEffect(() => {
    let cancelled = false

    async function run(): Promise<void> {
      setLoading(true)
      setFetchError(null)
      try {
        const [detailData, devModeData] = await Promise.all([
          getAdminRequestDetail(requestId),
          getDevMode().catch(() => ({ enabled: false, capture4xx: false })),
        ])
        if (cancelled) return
        setItem(detailData.item)
        setDevModeEnabled(devModeData.enabled)
        setHasOutbound(detailData.has_outbound === true)
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof AdminApiError ? err.message : String(err)
        setFetchError(msg)
        setItem(null)
        setHasOutbound(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    if (requestId) void run()

    return () => {
      cancelled = true
    }
  }, [requestId])

  function refresh(): void {
    setRefreshing(true)
    Promise.all([
      getAdminRequestDetail(requestId),
      getDevMode().catch(() => ({ enabled: false, capture4xx: false })),
    ])
      .then(([detailData, devModeData]) => {
        setItem(detailData.item)
        setDevModeEnabled(devModeData.enabled)
        setHasOutbound(detailData.has_outbound === true)
        setFetchError(null)
      })
      .catch((err: unknown) => {
        const msg = err instanceof AdminApiError ? err.message : String(err)
        toast.error(i18n.t("requestDetailPage.loadFailedTitle"), {
          description: msg,
        })
      })
      .finally(() => setRefreshing(false))
  }

  function retry(): void {
    setLoading(true)
    setFetchError(null)
    Promise.all([
      getAdminRequestDetail(requestId),
      getDevMode().catch(() => ({ enabled: false, capture4xx: false })),
    ])
      .then(([detailData, devModeData]) => {
        setItem(detailData.item)
        setDevModeEnabled(devModeData.enabled)
        setHasOutbound(detailData.has_outbound === true)
      })
      .catch((err: unknown) => {
        const msg = err instanceof AdminApiError ? err.message : String(err)
        setFetchError(msg)
        setItem(null)
        setHasOutbound(false)
      })
      .finally(() => setLoading(false))
  }

  async function copyText(
    value: string,
    successMessage: string,
  ): Promise<void> {
    try {
      await writeClipboardText(value)
      toast.success(successMessage)
    } catch (err) {
      toast.error(t("requestDetailPage.toast.copyFailed"), {
        description: String(err),
      })
    }
  }

  function downloadText(
    value: string,
    fileName: string,
    mimeType: string,
    successMessage: string,
  ): void {
    try {
      const blob = new Blob([value], { type: mimeType })
      const url = URL.createObjectURL(blob)

      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = fileName
      anchor.click()

      URL.revokeObjectURL(url)
      toast.success(successMessage)
    } catch (err) {
      toast.error(t("requestDetailPage.toast.downloadFailed"), {
        description: String(err),
      })
    }
  }

  async function copyRaw(): Promise<void> {
    if (!item) return

    await copyText(
      JSON.stringify(item, null, 2),
      t("requestDetailPage.toast.copiedJson"),
    )
  }

  function downloadRaw(): void {
    if (!item) return

    downloadText(
      JSON.stringify(item, null, 2),
      `${item.request_id}.json`,
      "application/json",
      t("requestDetailPage.toast.downloadedJson"),
    )
  }

  async function copyOwnerKeys(row: RequestDetailResponsesItemOwnerRow): Promise<void> {
    if (row.value.empty) return

    await copyText(row.value.raw, t("requestDetailPage.toast.copiedText"))
  }

  function downloadOwnerKeys(row: RequestDetailResponsesItemOwnerRow): void {
    if (row.value.empty) return

    downloadText(
      row.value.raw,
      `${requestId}-${row.id}-owner-keys.txt`,
      "text/plain;charset=utf-8",
      t("requestDetailPage.toast.downloadedText"),
    )
  }

  /* Loading state */
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("requestDetailPage.title")}</CardTitle>
          <CardDescription>
            <Skeleton className="h-4 w-40" />
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        </CardContent>
      </Card>
    )
  }

  /* Error / not-found state */
  if (fetchError || !item) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to={backTo}>
              <ArrowLeftIcon className="size-4" />
              {t("common.back")}
            </Link>
          </Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("requestDetailPage.title")}</CardTitle>
            <CardDescription>
              {t("requestDetailPage.notFoundDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <InlineAlert
              variant="warning"
              title={
                fetchError
                  ? t("requestDetailPage.loadFailedTitle")
                  : t("requestDetailPage.notFoundTitle")
              }
              description={fetchError || `request_id: ${requestId}`}
            />
            <Button variant="outline" size="sm" onClick={retry}>
              <RefreshCwIcon className="size-4" />
              {t("common.retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const quota = formatRequestCreditsRemaining(item)
  const ownerKeyRows = buildRequestDetailResponsesItemOwnerRows(item)
  const activeOwnerKeysRow =
    ownerKeyRows.find((row) => row.id === activeOwnerKeysRowId) ?? null

  return (
    <div className="space-y-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
      {/* Back + Refresh toolbar */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to={backTo}>
            <ArrowLeftIcon className="size-4" />
            {t("common.back")}
          </Link>
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {devModeEnabled && (
            hasOutbound ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/requests/${item.request_id}/replay`}>
                  <PlayIcon className="size-4" />
                  {t("requestDetailPage.replay.button")}
                </Link>
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" disabled>
                    <PlayIcon className="size-4" />
                    {t("requestDetailPage.replay.button")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("requestDetailPage.replay.noBlob")}
                </TooltipContent>
              </Tooltip>
            )
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={refreshing}
            onClick={refresh}
          >
            {refreshing ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      {/* Header card */}
      <Card
        className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 fill-mode-backwards"
        style={{ animationDelay: "50ms" }}
      >
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{item.request_id}</span>
            <StatusBadge status={item.http_status} />
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            {fmtLocalDateTime(item.started_at_ms)}
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-[1fr_2fr]">
        {/* Summary card */}
        <Card
          className="min-w-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 fill-mode-backwards"
          style={{ animationDelay: "100ms" }}
        >
          <CardHeader>
            <CardTitle>{t("requestDetailPage.summaryTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-hidden">
            <Table className="table-fixed">
              <TableBody>
                {/* ── Request ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.request")}
                />
                <TableRow>
                  <TableCell className="w-36 text-muted-foreground">
                    {t("requestDetailPage.fields.time")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtLocalDateTime(item.started_at_ms) || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.path")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    <Link
                      to={`/requests?path=${encodeURIComponent(item.path)}`}
                      className="underline decoration-border hover:decoration-foreground"
                    >
                      {item.path}
                    </Link>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.endpoint")}
                      tooltip={t("requestDetailPage.fieldTooltip.endpoint")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.upstream_endpoint || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.model")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.upstream_model || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.duration")}
                      tooltip={t("requestDetailPage.fieldTooltip.duration")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtDurationSeconds(item.duration_ms) || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.ttfb")}
                      tooltip={t("requestDetailPage.fieldTooltip.ttfb")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtDurationSeconds(item.ttfb_ms) || EMPTY}
                  </TableCell>
                </TableRow>

                {/* ── Routing ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.routing")}
                />
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.account")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.account_id ? (
                      <Link
                        to={`/requests?account_id=${encodeURIComponent(item.account_id)}`}
                        className="underline decoration-border hover:decoration-foreground"
                      >
                        {item.account_id}
                      </Link>
                    ) : (
                      EMPTY
                    )}
                    {item.affinity_hit ? (
                      <Badge variant="outline" className="ml-2">
                        {t("requestDetailPage.fields.affinityHit")}
                      </Badge>
                    ) : null}
                  </TableCell>
                </TableRow>
                {item.affinity_cache_key ? (
                  <TableRow>
                    <TableCell className="text-muted-foreground">
                      <FieldLabel
                        label={t("requestDetailPage.fields.affinityCacheKey")}
                        tooltip={t(
                          "requestDetailPage.fieldTooltip.affinityCacheKey",
                        )}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-normal break-words">
                      {item.affinity_cache_key}
                    </TableCell>
                  </TableRow>
                ) : null}
                {ownerKeyRows.map((row) => (
                  <TableRow key={row.labelKey}>
                    <TableCell className="text-muted-foreground">
                      <FieldLabel
                        label={t(row.labelKey)}
                        tooltip={t(row.tooltipKey)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <OwnerKeysSummaryValue
                        row={row}
                        onView={() => setActiveOwnerKeysRowId(row.id)}
                        onCopy={() => void copyOwnerKeys(row)}
                        onDownload={() => downloadOwnerKeys(row)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.affinityKeyUsed")}
                      tooltip={t("requestDetailPage.fieldTooltip.affinityKeyUsed")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.affinity_key_used || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.affinityKeySource")}
                      tooltip={t("requestDetailPage.fieldTooltip.affinityKeySource")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.affinity_key_source || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.selectionReason")}
                      tooltip={t("requestDetailPage.fieldTooltip.selectionReason")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.selection_reason || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.initiator")}
                      tooltip={t("requestDetailPage.fieldTooltip.initiator")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.initiator || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.upstreamRequestId")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.upstreamRequestId",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.upstream_request_id || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.upstreamErrorMessageRaw")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.upstreamErrorMessageRaw",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.upstream_error_message_raw || EMPTY}
                  </TableCell>
                </TableRow>

                {/* ── Upstream Headers ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.upstreamHeaders")}
                />
                {buildRequestDetailUpstreamHeaderRows(item).map((row) => (
                  <TableRow key={row.labelKey}>
                    <TableCell className="text-muted-foreground">
                      <FieldLabel
                        label={t(row.labelKey)}
                        tooltip={t(row.tooltipKey)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-normal break-words">
                      {row.value}
                    </TableCell>
                  </TableRow>
                ))}

                {/* ── Client ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.client")}
                />
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.userId")}
                      tooltip={t("requestDetailPage.fieldTooltip.userId")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.user_id || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.safetyIdentifier")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.safetyIdentifier",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.safety_identifier || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.promptCacheKey")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.promptCacheKey",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.prompt_cache_key || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.clientIp")}
                      tooltip={t("requestDetailPage.fieldTooltip.clientIp")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.client_ip || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.inboundUserAgent")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.inboundUserAgent",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.user_agent || EMPTY}
                  </TableCell>
                </TableRow>

                {/* ── Usage ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.usage")}
                />
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.tokens")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.tokens.in")}:
                        </span>{" "}
                        {item.tokens_input != null
                          ? fmtNum(item.tokens_input)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.tokens.out")}:
                        </span>{" "}
                        {item.tokens_output != null
                          ? fmtNum(item.tokens_output)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.tokens.total")}:
                        </span>{" "}
                        {item.tokens_total != null
                          ? fmtNum(item.tokens_total)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.tokens.cached")}:
                        </span>{" "}
                        {item.tokens_cached_input != null
                          ? fmtNum(item.tokens_cached_input)
                          : EMPTY}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.quota")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.quota.before")}:
                        </span>{" "}
                        {item.credits_remaining_before != null
                          ? fmtNum(item.credits_remaining_before)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.quota.after")}:
                        </span>{" "}
                        {item.credits_remaining_after != null
                          ? fmtNum(item.credits_remaining_after)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.quota.diff")}:
                        </span>{" "}
                        {item.credits_remaining_diff != null
                          ? fmtNum(item.credits_remaining_diff)
                          : EMPTY}
                        {quota ? ` (${quota})` : ""}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Raw JSON card */}
        <Card
          className="min-w-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 fill-mode-backwards"
          style={{ animationDelay: "150ms" }}
        >
          <CardHeader>
            <CardTitle>{t("requestDetailPage.rawTitle")}</CardTitle>
            <CardDescription>
              {t("requestDetailPage.rawDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                placeholder={t("requestDetailPage.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 sm:max-w-xs"
              />
              <div className="flex items-center gap-2 sm:ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={downloadRaw}
                >
                  <DownloadIcon className="size-4" />
                  {t("common.download")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyRaw()}
                >
                  {t("common.copyJson")}
                </Button>
              </div>
            </div>

            <JsonViewer value={item} search={search} />
          </CardContent>
        </Card>
      </div>

      <OwnerKeysViewer
        key={activeOwnerKeysRow?.id ?? "closed"}
        row={activeOwnerKeysRow}
        open={activeOwnerKeysRow !== null}
        isDesktop={isDesktop}
        onOpenChange={(open) => {
          if (!open) {
            setActiveOwnerKeysRowId(null)
          }
        }}
        onCopy={() => {
          if (activeOwnerKeysRow) {
            void copyOwnerKeys(activeOwnerKeysRow)
          }
        }}
        onDownload={() => {
          if (activeOwnerKeysRow) {
            downloadOwnerKeys(activeOwnerKeysRow)
          }
        }}
      />
    </div>
  )
}
