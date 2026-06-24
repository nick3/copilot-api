import { RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { InlineAlert } from "@/components/ui/inline-alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  AdminApiError,
  getTokenUsageDaily,
  getTokenUsageEvents,
  getTokenUsageSummary,
  type TokenUsageCost,
  type TokenUsageDailyBucket,
  type TokenUsageDailySummary,
  type TokenUsageEventRecord,
  type TokenUsageEventsPage,
  type TokenUsagePeriod,
  type TokenUsageSummary,
  type TokenUsageTotals,
} from "@/lib/admin-api"
import { fmtLocalDateTime, fmtNum } from "@/lib/format"
import { i18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"

const TOKEN_USAGE_PERIODS: Array<TokenUsagePeriod> = ["day", "week", "month"]
const EVENTS_PAGE_SIZE = 20

function formatNumber(value: number | null | undefined): string {
  return fmtNum(value) || "—"
}

function formatCostAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "—"
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: amount > 0 && amount < 1 ? 9 : 4,
  }).format(amount)
}

function formatProviderCost(cost: TokenUsageCost): string {
  return `${formatCostAmount(cost.amount)} ${cost.currency}`
}

function formatProviderCosts(costs: Array<TokenUsageCost>): string {
  return costs.length > 0 ? costs.map(formatProviderCost).join(" · ") : "—"
}

function formatEventCost(event: TokenUsageEventRecord): string {
  return event.cost ? formatProviderCost(event.cost) : "—"
}

function hasUsage(totals: TokenUsageTotals | null | undefined): boolean {
  return Boolean(totals && totals.request_count > 0)
}

function MetricCard({
  label,
  value,
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function SummarySkeleton(): React.JSX.Element {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <Card key={index}>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-32" />
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

function SummaryCards({ totals }: { totals: TokenUsageTotals }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label={t("tokenUsagePage.metrics.requests")}
        value={formatNumber(totals.request_count)}
      />
      <MetricCard
        label={t("tokenUsagePage.metrics.inputTokens")}
        value={formatNumber(totals.input_tokens)}
      />
      <MetricCard
        label={t("tokenUsagePage.metrics.outputTokens")}
        value={formatNumber(totals.output_tokens)}
      />
      <MetricCard
        label={t("tokenUsagePage.metrics.cacheReadTokens")}
        value={formatNumber(totals.cache_read_input_tokens)}
      />
      <MetricCard
        label={t("tokenUsagePage.metrics.cacheCreationTokens")}
        value={formatNumber(totals.cache_creation_input_tokens)}
      />
      <MetricCard
        label={t("tokenUsagePage.metrics.totalTokens")}
        value={formatNumber(totals.total_tokens)}
      />
      <MetricCard
        label={t("tokenUsagePage.metrics.nanoAiu")}
        value={formatNumber(totals.total_nano_aiu)}
      />
      <MetricCard
        label={t("tokenUsagePage.metrics.providerCost")}
        value={formatProviderCosts(totals.costs)}
      />
    </div>
  )
}

function DailyRows({ days }: { days: Array<TokenUsageDailyBucket> }): React.JSX.Element {
  const { t } = useTranslation()

  if (days.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={8} className="text-muted-foreground py-8 text-center">
          {t("tokenUsagePage.empty.daily")}
        </TableCell>
      </TableRow>
    )
  }

  return (
    <>
      {days.map((day) => (
        <TableRow key={day.date}>
          <TableCell className="font-medium">{day.date}</TableCell>
          <TableCell>{formatNumber(day.totals.request_count)}</TableCell>
          <TableCell>{formatNumber(day.totals.input_tokens)}</TableCell>
          <TableCell>{formatNumber(day.totals.output_tokens)}</TableCell>
          <TableCell>{formatNumber(day.totals.cache_read_input_tokens)}</TableCell>
          <TableCell>{formatNumber(day.totals.cache_creation_input_tokens)}</TableCell>
          <TableCell>{formatNumber(day.totals.total_tokens)}</TableCell>
          <TableCell>{formatProviderCosts(day.totals.costs)}</TableCell>
        </TableRow>
      ))}
    </>
  )
}

function DailyTable({ daily }: { daily: TokenUsageDailySummary | null }): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tokenUsagePage.daily.title")}</CardTitle>
        <CardDescription>{t("tokenUsagePage.daily.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("tokenUsagePage.columns.date")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.requests")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.input")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.output")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.cacheRead")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.cacheCreate")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.total")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.providerCost")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <DailyRows days={daily?.days ?? []} />
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function EventsRows({
  items,
}: {
  items: Array<TokenUsageEventRecord>
}): React.JSX.Element {
  const { t } = useTranslation()

  if (items.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={11} className="text-muted-foreground py-8 text-center">
          {t("tokenUsagePage.empty.events")}
        </TableCell>
      </TableRow>
    )
  }

  return (
    <>
      {items.map((event) => (
        <TableRow key={event.id}>
          <TableCell>{fmtLocalDateTime(event.created_at_ms) || event.created_at_utc}</TableCell>
          <TableCell>{event.source}</TableCell>
          <TableCell>{event.endpoint}</TableCell>
          <TableCell>{event.provider_name || "—"}</TableCell>
          <TableCell className="font-mono text-xs">{event.model}</TableCell>
          <TableCell>{formatNumber(event.input_tokens)}</TableCell>
          <TableCell>{formatNumber(event.output_tokens)}</TableCell>
          <TableCell>{formatNumber(event.cache_read_input_tokens)}</TableCell>
          <TableCell>{formatNumber(event.total_tokens)}</TableCell>
          <TableCell>{formatEventCost(event)}</TableCell>
          <TableCell className="max-w-56 whitespace-normal break-words font-mono text-xs">
            {event.trace_id || event.session_id ?
              `${event.trace_id || "—"} / ${event.session_id || "—"}`
            : "—"}
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}

function EventsTable({
  events,
  loading,
  onNextPage,
  onPreviousPage,
}: {
  events: TokenUsageEventsPage | null
  loading: boolean
  onNextPage: () => void
  onPreviousPage: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const page = events?.page ?? 1
  const totalPages = events?.total_pages ?? 1
  const canPrevious = page > 1
  const canNext = page < totalPages

  return (
    <Card>
      <CardHeader className="gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t("tokenUsagePage.events.title")}</CardTitle>
          <CardDescription>{t("tokenUsagePage.events.description")}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">
            {t("tokenUsagePage.events.page", {
              page,
              totalPages,
              total: events?.total ?? 0,
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onPreviousPage}
            disabled={!canPrevious || loading}
          >
            {t("tokenUsagePage.events.previous")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNextPage}
            disabled={!canNext || loading}
          >
            {t("tokenUsagePage.events.next")}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("tokenUsagePage.columns.time")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.source")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.endpoint")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.provider")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.model")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.input")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.output")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.cacheRead")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.total")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.providerCost")}</TableHead>
              <TableHead>{t("tokenUsagePage.columns.traceSession")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <EventsRows items={events?.items ?? []} />
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function TokenUsagePage(): React.JSX.Element {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<TokenUsagePeriod>("day")
  const [eventPage, setEventPage] = useState(1)
  const [summary, setSummary] = useState<TokenUsageSummary | null>(null)
  const [daily, setDaily] = useState<TokenUsageDailySummary | null>(null)
  const [events, setEvents] = useState<TokenUsageEventsPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadInFlightRef = useRef(false)

  const refresh = useCallback(async () => {
    if (loadInFlightRef.current) return

    loadInFlightRef.current = true
    setLoading(true)
    setError(null)

    try {
      const [summaryRes, dailyRes, eventsRes] = await Promise.all([
        getTokenUsageSummary({ period }),
        getTokenUsageDaily({ period }),
        getTokenUsageEvents({
          page: eventPage,
          pageSize: EVENTS_PAGE_SIZE,
          period,
        }),
      ])
      setSummary(summaryRes)
      setDaily(dailyRes)
      setEvents(eventsRes)
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error(i18n.t("tokenUsagePage.loadFailedTitle"), { description: msg })
    } finally {
      loadInFlightRef.current = false
      setLoading(false)
    }
  }, [eventPage, period])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const isEmpty = useMemo(() => !hasUsage(summary?.totals), [summary])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{t("tokenUsagePage.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("tokenUsagePage.description")}
          </p>
        </div>

        <Select
          value={period}
          onValueChange={(value) => {
            setPeriod(value as TokenUsagePeriod)
            setEventPage(1)
          }}
        >
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TOKEN_USAGE_PERIODS.map((item) => (
              <SelectItem key={item} value={item}>
                {t(`tokenUsagePage.period.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
          {loading ? t("common.refreshing") : t("common.refresh")}
        </Button>
      </div>

      {error ? (
        <InlineAlert
          variant="error"
          title={t("tokenUsagePage.loadFailedTitle")}
          description={error}
          actionLabel={t("common.retry")}
          onAction={refresh}
        />
      ) : null}

      <InlineAlert
        variant="info"
        title={t("tokenUsagePage.semanticTitle")}
        description={t("tokenUsagePage.semanticDescription")}
      />

      {loading && !summary ? <SummarySkeleton /> : null}
      {summary ? <SummaryCards totals={summary.totals} /> : null}

      {!loading && summary && isEmpty ? (
        <InlineAlert
          variant="info"
          title={t("tokenUsagePage.empty.title")}
          description={t("tokenUsagePage.empty.description")}
        />
      ) : null}

      <DailyTable daily={daily} />
      <EventsTable
        events={events}
        loading={loading}
        onPreviousPage={() => setEventPage((current) => Math.max(1, current - 1))}
        onNextPage={() => setEventPage((current) => current + 1)}
      />
    </div>
  )
}
