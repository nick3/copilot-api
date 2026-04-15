import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { AccountUsageChart } from "@/components/charts/account-usage-chart"
import { PremiumUsageChart } from "@/components/charts/premium-usage-chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AdminApiError,
  type DailyAccountStatsItem,
  type DailyStatsItem,
  getAdminPremiumStats,
} from "@/lib/admin-api"
import { i18n } from "@/lib/i18n"
import {
  type StatisticsTimePreset,
  resolveStatisticsRange,
} from "@/lib/statistics-range"

type TimePreset = StatisticsTimePreset

export function StatisticsPage(): React.JSX.Element {
  const { t } = useTranslation()

  const [preset, setPreset] = useState<TimePreset>("7d")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [autoRefreshMs, setAutoRefreshMs] = useState(0)

  const [loading, setLoading] = useState(false)
  const [daily, setDaily] = useState<Array<DailyStatsItem>>([])
  const [byAccount, setByAccount] = useState<Array<DailyAccountStatsItem>>([])
  const [isHourly, setIsHourly] = useState(false)

  const loadInFlightRef = useRef(false)
  const autoRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (loadInFlightRef.current) return
    loadInFlightRef.current = true
    setLoading(true)

    try {
      const range = resolveStatisticsRange({
        preset,
        customFrom,
        customTo,
      })
      const res = await getAdminPremiumStats({
        from: range.from,
        to: range.to,
        granularity: range.granularity,
      })
      setDaily(res.daily)
      setByAccount(res.by_account)
      setIsHourly(range.granularity === "hour")
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      toast.error(i18n.t("statistics.loadFailed"), { description: msg })
    } finally {
      loadInFlightRef.current = false
      setLoading(false)
    }
  }, [preset, customFrom, customTo])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Auto-refresh with recursive setTimeout
  useEffect(() => {
    let disposed = false

    if (autoRefreshRef.current) {
      clearTimeout(autoRefreshRef.current)
      autoRefreshRef.current = null
    }

    if (autoRefreshMs > 0) {
      const scheduleNext = () => {
        if (disposed) return
        autoRefreshRef.current = setTimeout(async () => {
          if (loadInFlightRef.current) {
            scheduleNext()
            return
          }
          try {
            await refresh()
          } finally {
            scheduleNext()
          }
        }, autoRefreshMs)
      }

      scheduleNext()
    }

    return () => {
      disposed = true
      if (autoRefreshRef.current) {
        clearTimeout(autoRefreshRef.current)
        autoRefreshRef.current = null
      }
    }
  }, [autoRefreshMs, refresh])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t("statistics.title")}</h1>

        <div className="flex items-center gap-2">
          <Select
            value={preset}
            onValueChange={(v) => setPreset(v as TimePreset)}
          >
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">
                {t("statistics.timeRange.today")}
              </SelectItem>
              <SelectItem value="7d">{t("statistics.timeRange.7d")}</SelectItem>
              <SelectItem value="month">
                {t("statistics.timeRange.month")}
              </SelectItem>
              <SelectItem value="custom">
                {t("statistics.timeRange.custom")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="border-input bg-background text-foreground h-8 rounded-md border px-2 text-sm"
            />
            <span className="text-muted-foreground text-sm">-</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="border-input bg-background text-foreground h-8 rounded-md border px-2 text-sm"
            />
          </div>
        )}

        <div className="flex items-center gap-2">
          {autoRefreshMs > 0 && (
            <span className="relative flex h-2 w-2">
              <span className="bg-primary absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping" />
              <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
            </span>
          )}
          <Select
            value={String(autoRefreshMs)}
            onValueChange={(v) => setAutoRefreshMs(Number(v))}
          >
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">
                {t("statistics.autoRefresh.off")}
              </SelectItem>
              <SelectItem value="30000">
                {t("statistics.autoRefresh.30s")}
              </SelectItem>
              <SelectItem value="60000">
                {t("statistics.autoRefresh.60s")}
              </SelectItem>
              <SelectItem value="300000">
                {t("statistics.autoRefresh.5m")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading && daily.length === 0 ?
        <div className="space-y-6">
          <div className="bg-muted h-[380px] animate-pulse rounded-xl" />
          <div className="bg-muted h-[380px] animate-pulse rounded-xl" />
        </div>
      : <>
          <PremiumUsageChart data={daily} isHourly={isHourly} />
          <AccountUsageChart data={byAccount} isHourly={isHourly} />
        </>
      }
    </div>
  )
}
